import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { signInCodeEmail } from "@/lib/email-templates";

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
export async function requestAuthCode(params: { email: string; ip: string | null }): Promise<RequestCodeResult> {
  const email = normalizeEmail(params.email);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const lastCode = await prisma.authCode.findFirst({
    where: { email, purpose: "SIGN_IN" },
    orderBy: { createdAt: "desc" },
  });

  if (lastCode) {
    const elapsedSeconds = (now.getTime() - lastCode.createdAt.getTime()) / 1000;
    if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
      return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds) };
    }
  }

  const emailCount = await prisma.authCode.count({
    where: { email, purpose: "SIGN_IN", createdAt: { gt: hourAgo } },
  });
  if (emailCount >= MAX_CODES_PER_EMAIL_PER_HOUR) {
    await auditAuthEvent({ action: "auth.code_rate_limited", email, metadata: { scope: "email", ip: params.ip } });
    return { ok: false, reason: "rate_limited" };
  }

  if (params.ip) {
    const ipCount = await prisma.authCode.count({
      where: { requestIp: params.ip, purpose: "SIGN_IN", createdAt: { gt: hourAgo } },
    });
    if (ipCount >= MAX_CODES_PER_IP_PER_HOUR) {
      await auditAuthEvent({ action: "auth.code_rate_limited", email, metadata: { scope: "ip", ip: params.ip } });
      return { ok: false, reason: "rate_limited" };
    }
  }

  const code = generateSixDigitCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_COST);

  await prisma.authCode.create({
    data: {
      email,
      purpose: "SIGN_IN",
      codeHash,
      maxAttempts: MAX_VERIFY_ATTEMPTS,
      requestIp: params.ip,
      expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000),
    },
  });

  const emailResult = await sendEmail({
    to: email,
    subject: "Your Rent A 4Wheel sign-in code",
    html: signInCodeEmail({ code, expiresInMinutes: CODE_TTL_MINUTES }),
  });

  await auditAuthEvent({ action: "auth.code_requested", email, metadata: { ip: params.ip, emailSent: emailResult.sent } });

  const isDev = process.env.NODE_ENV !== "production";
  return { ok: true, devCode: isDev && !emailResult.sent ? code : undefined };
}

/**
 * Verifies a submitted code against the most recent non-consumed AuthCode
 * for `email`. Single-use (marks `consumedAt` on success — a consumed code
 * can never be replayed), expiring, and attempt-limited (locks out further
 * guesses against that code after MAX_VERIFY_ATTEMPTS wrong tries).
 */
export async function verifyAuthCode(params: { email: string; code: string; ip: string | null }): Promise<VerifyCodeResult> {
  const email = normalizeEmail(params.email);
  const code = params.code.trim();

  const authCode = await prisma.authCode.findFirst({
    where: { email, purpose: "SIGN_IN", consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!authCode) {
    await auditAuthEvent({ action: "auth.code_verify_failed", email, metadata: { reason: "no_code", ip: params.ip } });
    return { ok: false, reason: "no_code" };
  }

  if (authCode.expiresAt < new Date()) {
    await auditAuthEvent({ action: "auth.code_verify_failed", email, metadata: { reason: "expired", ip: params.ip } });
    return { ok: false, reason: "expired" };
  }

  if (authCode.attempts >= authCode.maxAttempts) {
    await auditAuthEvent({ action: "auth.code_verify_failed", email, metadata: { reason: "locked", ip: params.ip } });
    return { ok: false, reason: "locked" };
  }

  const matches = await bcrypt.compare(code, authCode.codeHash);
  if (!matches) {
    await prisma.authCode.update({ where: { id: authCode.id }, data: { attempts: { increment: 1 } } });
    await auditAuthEvent({ action: "auth.code_verify_failed", email, metadata: { reason: "mismatch", ip: params.ip } });
    return { ok: false, reason: "mismatch" };
  }

  await prisma.authCode.update({ where: { id: authCode.id }, data: { consumedAt: new Date() } });
  await auditAuthEvent({ action: "auth.code_verify_succeeded", email, metadata: { ip: params.ip } });
  return { ok: true };
}

export function getRequestIp(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}
