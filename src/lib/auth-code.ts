import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { signInCodeEmail } from "@/lib/email-templates";
import { localDevelopment } from "@/lib/deployment-environment";

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
const MAX_CODES_PER_IP_PER_HOUR = 20;
const MAX_VERIFY_ATTEMPTS = 5;
const BCRYPT_COST = 10;

export type RequestCodeResult =
  | { ok: true; devCode?: string }
  | { ok: false; reason: "cooldown" | "rate_limited"; retryAfterSeconds?: number };

export type VerifyCodeResult =
  | { ok: true }
  | { ok: false; reason: "no_code" | "expired" | "locked" | "mismatch" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
}

async function auditAuthEvent(params: {
  actorId?: string | null;
  action: string;
  email: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId ?? null,
      action: params.action,
      entityType: "AuthCode",
      entityId: params.email,
      metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Issues a new six-digit sign-in code for `email`, subject to:
 *  - a resend cooldown (can't request again within RESEND_COOLDOWN_SECONDS
 *    of the last request for the same email)
 *  - a per-email rate limit (MAX_CODES_PER_EMAIL_PER_HOUR per rolling hour)
 *  - a per-IP rate limit (MAX_CODES_PER_IP_PER_HOUR per rolling hour)
 *
 * The plaintext code is only ever returned when `NODE_ENV !== "production"`
 * AND email sending isn't configured, so local development can proceed
 * without a real inbox — this mirrors the existing dev-mode fallback used
 * elsewhere in the app (Stripe, storage) and is never available in
 * production regardless of configuration.
 */
export async function requestAuthCode(params: { email: string; ip: string | null; purpose?: "SIGN_IN" | "EMERGENCY_OVERRIDE_STEP_UP" | "FINANCE_STEP_UP" | "SECURITY_STEP_UP" }): Promise<RequestCodeResult> {
  const email = normalizeEmail(params.email);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const code = generateSixDigitCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST);
  const issued = await prisma.$transaction(async tx => {
    // Stable ordering serializes both per-email and per-IP issuance limits.
    const scopes = ["auth-email:" + email, ...(params.ip ? ["auth-ip:" + params.ip] : [])].sort();
    for (const scope of scopes) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope},0))::text`;
    const last = await tx.authCode.findFirst({ where: { email, purpose: params.purpose ?? "SIGN_IN" }, orderBy: { createdAt: "desc" } });
    if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) return { ok: false as const, reason: "cooldown" as const, retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - (now.getTime() - last.createdAt.getTime())) / 1000) };
    const emailCount = await tx.authCode.count({ where: { email, purpose: params.purpose ?? "SIGN_IN", createdAt: { gt: hourAgo } } });
    const ipCount = params.ip ? await tx.authCode.count({ where: { requestIp: params.ip, purpose: params.purpose ?? "SIGN_IN", createdAt: { gt: hourAgo } } }) : 0;
    if (emailCount >= MAX_CODES_PER_EMAIL_PER_HOUR || ipCount >= MAX_CODES_PER_IP_PER_HOUR) return { ok: false as const, reason: "rate_limited" as const };
    await tx.authCode.updateMany({ where: { email, purpose: params.purpose ?? "SIGN_IN", consumedAt: null }, data: { consumedAt: now } });
    await tx.authCode.create({ data: { email, purpose: params.purpose ?? "SIGN_IN", codeHash, maxAttempts: MAX_VERIFY_ATTEMPTS, requestIp: params.ip, expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60000) } });
    return { ok: true as const };
  });
  if (!issued.ok) return issued;

  const emailResult = await sendEmail({
    to: email,
    subject: "Your Rent A 4Wheel sign-in code",
    html: signInCodeEmail({ code, expiresInMinutes: CODE_TTL_MINUTES }),
  });

  await auditAuthEvent({ action: "auth.code_requested", email, metadata: { ip: params.ip, emailSent: emailResult.sent } });

  const isDev = localDevelopment();
  return { ok: true, devCode: isDev && !emailResult.sent ? code : undefined };
}

/**
 * Verifies a submitted code against the most recent non-consumed AuthCode
 * for `email`. Single-use (marks `consumedAt` on success — a consumed code
 * can never be replayed), expiring, and attempt-limited (locks out further
 * guesses against that code after MAX_VERIFY_ATTEMPTS wrong tries).
 */
export async function verifyAuthCode(params: { email: string; code: string; ip: string | null; purpose?: "SIGN_IN" | "EMERGENCY_OVERRIDE_STEP_UP" | "FINANCE_STEP_UP" | "SECURITY_STEP_UP" }): Promise<VerifyCodeResult> {
  const email = normalizeEmail(params.email);
  const code = params.code.trim();

  const result: VerifyCodeResult = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"auth-email:" + email},0))::text`;
    const authCode = await tx.authCode.findFirst({ where: { email, purpose: params.purpose ?? "SIGN_IN" }, orderBy: { createdAt: "desc" } });
    if (!authCode || authCode.consumedAt) return { ok: false, reason: "no_code" };
    if (authCode.expiresAt <= new Date()) return { ok: false, reason: "expired" };
    if (authCode.attempts >= authCode.maxAttempts) return { ok: false, reason: "locked" };
    // Reserve the attempt while holding the email guard, before expensive hash
    // verification. Parallel guesses cannot each borrow the same final attempt.
    await tx.authCode.update({ where: { id: authCode.id }, data: { attempts: { increment: 1 } } });
    if (!await bcrypt.compare(code, authCode.codeHash)) return { ok: false, reason: "mismatch" };
    if (authCode.expiresAt <= new Date()) return { ok: false, reason: "expired" };
    await tx.authCode.update({ where: { id: authCode.id }, data: { consumedAt: new Date() } });
    return { ok: true };
  });
  await auditAuthEvent({ action: result.ok ? "auth.code_verify_succeeded" : "auth.code_verify_failed", email, metadata: { ...(result.ok ? {} : { reason: result.reason }), ip: params.ip } });
  return result;
}

export function getRequestIp(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}
