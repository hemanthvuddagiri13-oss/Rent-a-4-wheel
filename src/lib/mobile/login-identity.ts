import { createHmac, randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { signInCodeEmail } from "@/lib/email-templates";
import { createServiceCase } from "@/lib/service-cases";
import { authenticateMobile, issueMobileSession, MobileError, mobileDeviceSchema } from "./auth";
import { smsProvider, type SmsVerificationProvider } from "./sms-provider";

type Tx = Prisma.TransactionClient;
export const identityPurpose = z.enum(["LINK_PHONE", "CURRENT_PHONE", "CHANGE_PHONE", "RECOVERY", "LINK_EMAIL"]);
export const identityRequest = z.object({ purpose: identityPurpose, target: z.string().min(3).max(254), proofId: z.uuid().optional() }).strict();
export const phoneRequest = z.object({ phone: z.string().min(7).max(40), deviceId: z.uuid() }).strict();
export const phoneVerify = mobileDeviceSchema.extend({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) });
export const identityVerify = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict();
const hash = (value: string) => createHmac("sha256", process.env.AUTH_SECRET ?? "local-only").update("login:" + value).digest("hex");
export function normalizedPhone(value: string) {
  const phone = parsePhoneNumberFromString(value.trim(), "US");
  if (!phone?.isValid() || phone.ext) throw new MobileError("INVALID_REQUEST", 400);
  return phone.number;
}
async function guard(tx: Tx, scopes: string[]) { for (const scope of [...new Set(scopes)].sort()) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"login:" + scope},0))::text`; }
async function event(tx: Tx, action: string, id: string, actorId?: string | null) { await tx.auditLog.create({ data: { actorId, action: "mobile.identity." + action, entityType: "MobileLoginChallenge", entityId: id } }); }
async function freshActor(tx: Tx, headers: Headers) {
  const actor = await authenticateMobile(headers, tx, false);
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actor.userId} FOR UPDATE`;
  // Recheck after the same user lock used by revocation and identity changes.
  await authenticateMobile(headers, tx, false);
  const session = await tx.mobileSession.findUniqueOrThrow({ where: { id: actor.sessionId } });
  if (session.createdAt.getTime() < Date.now() - 10 * 60000) throw new MobileError("UNAUTHORIZED", 401);
  return { ...actor, deviceId: session.deviceId };
}

/** Generic accepted response includes an opaque challenge even for denied targets. */
export async function requestLoginChallenge(input: unknown, ipHash: string, headers?: Headers, db: PrismaClient = prisma, provider?: SmsVerificationProvider) {
  const data = headers ? identityRequest.parse(input) : phoneRequest.parse(input);
  const purpose = "purpose" in data ? data.purpose : "SIGN_IN";
  const channel = purpose === "LINK_EMAIL" ? "EMAIL" : "PHONE";
  const raw = "target" in data ? data.target : data.phone;
  const target = channel === "EMAIL" ? z.email().max(254).parse(raw.trim().toLowerCase()) : normalizedPhone(raw);
  if (target.endsWith(".invalid")) throw new MobileError("INVALID_REQUEST", 400);
  const targetHash = hash(target), id = randomUUID(), now = new Date();
  const code = channel === "EMAIL" ? String(randomInt(0, 1000000)).padStart(6, "0") : null;
  const codeHash = code ? await bcrypt.hash(code, 10) : null;
  const challenge = await db.$transaction(async tx => {
    const initial = headers ? await authenticateMobile(headers, tx, false) : null;
    const deviceId = initial ? (await tx.mobileSession.findUniqueOrThrow({ where: { id: initial.sessionId } })).deviceId : (data as z.infer<typeof phoneRequest>).deviceId;
    await guard(tx, ["target:" + targetHash, "ip:" + ipHash, "device:" + deviceId]);
    const actor = headers ? await freshActor(tx, headers) : null;
    const hour = new Date(now.getTime() - 3600000);
    const [last, perTarget, perIp, perDevice] = await Promise.all([
      tx.mobileLoginChallenge.findFirst({ where: { targetHash }, orderBy: { createdAt: "desc" } }),
      tx.mobileLoginChallenge.count({ where: { targetHash, createdAt: { gt: hour } } }),
      tx.mobileLoginChallenge.count({ where: { ipHash, createdAt: { gt: hour } } }),
      tx.mobileLoginChallenge.count({ where: { deviceId, createdAt: { gt: hour } } }),
    ]);
    if (last && last.createdAt.getTime() > now.getTime() - 60000 || perTarget >= 5 || perIp >= 20 || perDevice >= 10) {
      await event(tx, "throttled", id, actor?.userId); return null;
    }
    let denied = false, previousPhone: string | null = null, previousPhoneVersion: number | null = null;
    if (actor) {
      const [identity, user] = await Promise.all([tx.mobilePhoneIdentity.findUnique({ where: { userId: actor.userId } }), tx.user.findUniqueOrThrow({ where: { id: actor.userId } })]);
      previousPhone = identity?.phone ?? null;
      previousPhoneVersion = identity?.version ?? null;
      if (purpose === "LINK_EMAIL") {
        const owner = await tx.user.findUnique({ where: { email: target } });
        denied = Boolean(owner && owner.id !== actor.userId || user.emailVerified && user.email !== target);
      } else {
        const owner = await tx.mobilePhoneIdentity.findUnique({ where: { phone: target } });
        denied = Boolean(owner && owner.userId !== actor.userId);
        if (purpose === "LINK_PHONE") denied ||= Boolean(identity);
        if (purpose === "CURRENT_PHONE") denied ||= !identity || identity.phone !== target;
        if (["CHANGE_PHONE", "RECOVERY"].includes(purpose)) denied ||= !identity || identity.phone === target;
        if (purpose === "RECOVERY") denied ||= !user.emailVerified || user.email.endsWith("@phone.identity.invalid");
        if (purpose === "CHANGE_PHONE") {
          const proofId = "proofId" in data ? data.proofId : undefined;
          const proof = proofId ? await tx.mobileLoginChallenge.findUnique({ where: { id: proofId } }) : null;
          if (!proof || proof.purpose !== "CURRENT_PHONE" || proof.state !== "PROVED" || proof.sessionId !== actor.sessionId || proof.target !== identity?.phone || proof.previousPhoneVersion !== identity?.version || proof.expiresAt <= now) denied = true;
          else if (!denied) await tx.mobileLoginChallenge.update({ where: { id: proof.id }, data: { state: "CONSUMED", consumedAt: now } });
        }
      }
    }
    // Freeze an existing login binding. A later removal must not turn this
    // challenge into registration, or authorize a recycled/re-linked number.
    const loginIdentity = !actor ? await tx.mobilePhoneIdentity.findUnique({ where: { phone: target } }) : null;
    const record = await tx.mobileLoginChallenge.create({ data: { id, channel, purpose, target, targetHash, deviceId, ipHash, userId: actor?.userId ?? loginIdentity?.userId, sessionId: actor?.sessionId, previousPhone: loginIdentity?.phone ?? previousPhone, previousPhoneVersion: loginIdentity?.version ?? previousPhoneVersion, codeHash, state: denied ? "DENIED" : "CREATED", expiresAt: new Date(now.getTime() + 10 * 60000) } });
    await event(tx, "requested", id, actor?.userId); return record;
  });
  if (!challenge || challenge.state === "DENIED") return { accepted: true as const, challengeId: id, retryAfterSeconds: 60 };
  try {
    const providerSid = channel === "PHONE" ? await (provider ?? smsProvider()).start(target) : null;
    if (channel === "EMAIL") {
      const sent = await sendEmail({ to: target, subject: "Verify your Rent A 4Wheel login email", html: signInCodeEmail({ code: code!, expiresInMinutes: 10 }) });
      if (!sent.sent) throw new Error("EMAIL_UNAVAILABLE");
    }
    await db.mobileLoginChallenge.updateMany({ where: { id, state: "CREATED" }, data: { providerSid, state: "SENT" } });
  } catch {
    await db.$transaction(async tx => { await tx.mobileLoginChallenge.updateMany({ where: { id, state: "CREATED" }, data: { state: "FAILED" } }); await event(tx, "delivery_unavailable", id, challenge.userId); });
    throw new MobileError("UNAVAILABLE", 503);
  }
  return { accepted: true as const, challengeId: id, retryAfterSeconds: 60 };
}

export async function verifyLoginChallenge(input: unknown, headers?: Headers, db: PrismaClient = prisma, provider?: SmsVerificationProvider) {
  const data = headers ? identityVerify.parse(input) : phoneVerify.parse(input), claim = randomUUID();
  const challenge = await db.$transaction(async tx => {
    const actor = headers ? await freshActor(tx, headers) : null;
    await tx.$queryRaw`SELECT "id" FROM "MobileLoginChallenge" WHERE "id"=${data.challengeId} FOR UPDATE`;
    const c = await tx.mobileLoginChallenge.findUnique({ where: { id: data.challengeId } });
    if (!c || c.state !== "SENT" || c.expiresAt <= new Date() || c.attempts >= 5 || (actor ? c.sessionId !== actor.sessionId || c.userId !== actor.userId || c.purpose === "SIGN_IN" : c.purpose !== "SIGN_IN" || c.deviceId !== (data as z.infer<typeof phoneVerify>).deviceId)) return null;
    return tx.mobileLoginChallenge.update({ where: { id: c.id }, data: { state: "CHECKING", claim, attempts: { increment: 1 } } });
  });
  if (!challenge) throw new MobileError("UNAUTHORIZED", 401);
  let approved: boolean;
  try { approved = challenge.channel === "EMAIL" ? await bcrypt.compare(data.code, challenge.codeHash!) : await (provider ?? smsProvider()).check(challenge.providerSid!, data.code); }
  catch {
    await db.$transaction(async tx => { await tx.mobileLoginChallenge.updateMany({ where: { id: challenge.id, state: "CHECKING", claim }, data: { state: "FAILED", claim: null } }); await event(tx, "verification_uncertain", challenge.id, challenge.userId); });
    throw new MobileError("UNAVAILABLE", 503);
  }
  if (!approved) {
    await db.$transaction(async tx => { await tx.mobileLoginChallenge.updateMany({ where: { id: challenge.id, state: "CHECKING", claim }, data: { state: challenge.attempts >= 5 ? "FAILED" : "SENT", claim: null } }); await event(tx, "verification_rejected", challenge.id, challenge.userId); });
    throw new MobileError("UNAUTHORIZED", 401);
  }
  try {
    return await db.$transaction(async tx => {
      // Global identity-finalization order: sorted target locks, User, challenge.
      // Changing a number also serializes against registration/login on the old
      // number; no transaction can restore a session after change revocation.
      await guard(tx, ["target:" + challenge.targetHash, ...(challenge.purpose === "CHANGE_PHONE" && challenge.previousPhone ? ["target:" + hash(challenge.previousPhone)] : [])]);
      const actor = headers ? await freshActor(tx, headers) : null;
      const locator = challenge.purpose === "SIGN_IN" ? await tx.mobilePhoneIdentity.findUnique({ where: { phone: challenge.target } }) : null;
      if (locator) await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${locator.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "MobileLoginChallenge" WHERE "id"=${challenge.id} FOR UPDATE`;
      const c = await tx.mobileLoginChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
      if (c.state !== "CHECKING" || c.claim !== claim || c.expiresAt <= new Date()) throw new MobileError("UNAUTHORIZED", 401);
      if (c.providerSid) await tx.mobileVerificationReceipt.create({ data: { providerSid: c.providerSid, challengeId: c.id } });
      if (c.purpose === "SIGN_IN") {
        let identity = await tx.mobilePhoneIdentity.findUnique({ where: { phone: c.target } });
        // Re-read after the User lock, and validate both the locator and frozen
        // challenge version before issuance. Never trust a pre-lock identity.
        if ((identity?.userId ?? null) !== (locator?.userId ?? null) || (identity?.version ?? null) !== (locator?.version ?? null) ||
          c.userId && (!identity || identity.userId !== c.userId || identity.phone !== c.previousPhone || identity.version !== c.previousPhoneVersion)) throw new MobileError("UNAUTHORIZED", 401);
        if (!identity) {
          // Random non-deliverable internal address preserves the established web
          // schema; it is never a linked email or an account-matching input.
          const user = await tx.user.create({ data: { email: randomUUID() + "@phone.identity.invalid", phone: c.target, customer: { create: {} } } });
          identity = await tx.mobilePhoneIdentity.create({ data: { userId: user.id, phone: c.target } });
        }
        const credentials = await issueMobileSession(tx, identity.userId, data as z.infer<typeof phoneVerify>);
        await tx.mobileLoginChallenge.update({ where: { id: c.id }, data: { state: "CONSUMED", consumedAt: new Date(), claim: null } });
        await event(tx, "phone_signed_in", c.id, identity.userId); return credentials;
      }
      if (!actor || actor.userId !== c.userId || actor.sessionId !== c.sessionId) throw new MobileError("UNAUTHORIZED", 401);
      const current = await tx.mobilePhoneIdentity.findUnique({ where: { userId: actor.userId } });
      if ((current?.phone ?? null) !== c.previousPhone || (current?.version ?? null) !== c.previousPhoneVersion) throw new MobileError("CONFLICT", 409);
      if (c.purpose === "CURRENT_PHONE") {
        await tx.mobileLoginChallenge.update({ where: { id: c.id }, data: { state: "PROVED", claim: null, expiresAt: new Date(Date.now() + 5 * 60000) } });
        await event(tx, "current_phone_proved", c.id, actor.userId);
        return { outcome: "PROVED" as const, proofId: c.id, requiresSignIn: false, recoveryId: null };
      }
      let recoveryId: string | null = null;
      if (c.purpose === "LINK_EMAIL") {
        const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
        if (user.emailVerified && user.email !== c.target) throw new MobileError("CONFLICT", 409);
        await tx.user.update({ where: { id: actor.userId }, data: { email: c.target, emailVerified: new Date() } });
      } else if (c.purpose === "RECOVERY") {
        const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
        if (!user.emailVerified || !current) throw new MobileError("FORBIDDEN", 403);
        const prior = await tx.mobileIdentityRecovery.findFirst({ where: { userId: actor.userId, state: "REVIEW_REQUIRED" } });
        const record = prior ?? await tx.mobileIdentityRecovery.create({ data: { userId: actor.userId, sessionId: actor.sessionId, challengeId: c.id, previousPhone: current.phone, requestedPhone: c.target } });
        if (!prior) {
          const support = await createServiceCase(actor.userId, { kind: "TICKET", category: "GENERAL", title: "Account phone recovery — identity review required", body: `Recovery reference ${record.id}. The replacement number was verified, but account ownership requires independent identity review. Closing this support case does not approve or change any login method.` }, tx);
          await tx.mobileIdentityRecovery.update({ where: { id: record.id }, data: { caseId: support.id } });
        }
        recoveryId = record.id;
      } else {
        if (c.purpose === "LINK_PHONE" && current || c.purpose === "CHANGE_PHONE" && !current) throw new MobileError("CONFLICT", 409);
        // Invalidate pre-link registration approvals as well as old-number
        // approvals. A new owner must obtain a new challenge after the change.
        await tx.mobileLoginChallenge.updateMany({ where: { purpose: "SIGN_IN", target: { in: [c.target, ...(current ? [current.phone] : [])] }, state: { in: ["CREATED", "SENT", "CHECKING"] } }, data: { state: "FAILED", claim: null } });
        await tx.mobilePhoneIdentity.upsert({ where: { userId: actor.userId }, create: { userId: actor.userId, phone: c.target }, update: { phone: c.target, verifiedAt: new Date(), version: { increment: 1 } } });
        await tx.user.update({ where: { id: actor.userId }, data: { phone: c.target } });
      }
      const changed = c.purpose === "CHANGE_PHONE";
      if (c.purpose !== "RECOVERY") await tx.mobileSession.updateMany({ where: { userId: actor.userId, revokedAt: null, ...(changed ? {} : { id: { not: actor.sessionId } }) }, data: { revokedAt: new Date(), revocationReason: "LOGIN_METHOD_CHANGED" } });
      await tx.mobileLoginChallenge.update({ where: { id: c.id }, data: { state: "CONSUMED", consumedAt: new Date(), claim: null } });
      await event(tx, c.purpose === "RECOVERY" ? "recovery_review_required" : "method_linked", c.id, actor.userId);
      return { outcome: recoveryId ? "REVIEW_REQUIRED" as const : "LINKED" as const, proofId: null, requiresSignIn: changed, recoveryId };
    });
  } catch (error) {
    // A provider approval with uncertain/failed local commit cannot be reused.
    await db.mobileLoginChallenge.updateMany({ where: { id: challenge.id, state: "CHECKING", claim }, data: { state: "FAILED", claim: null } });
    if (error instanceof MobileError) throw error;
    throw new MobileError("CONFLICT", 409);
  }
}

export async function loginMethods(headers: Headers) {
  const actor = await authenticateMobile(headers), user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, include: { phoneIdentity: true } });
  const emailLinked = Boolean(user.emailVerified && !user.email.endsWith("@phone.identity.invalid"));
  const recovery = await prisma.mobileIdentityRecovery.findFirst({ where: { userId: actor.userId, state: "REVIEW_REQUIRED" }, select: { id: true } });
  return { phoneLinked: Boolean(user.phoneIdentity), phoneLabel: user.phoneIdentity ? "•••• " + user.phoneIdentity.phone.slice(-4) : null, emailLinked, email: emailLinked ? user.email : null, recoveryId: recovery?.id ?? null };
}
