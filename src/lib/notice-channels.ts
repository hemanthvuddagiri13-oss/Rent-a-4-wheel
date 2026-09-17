import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { marketplaceActor, MarketplaceError } from "@/lib/marketplace";

export async function requestSmsConsent(userId: string, phone: string, consent: boolean) {
  await marketplaceActor(prisma, userId);
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !consent) throw new MarketplaceError("Enter an international phone number and explicitly consent to account texts.");
  // A request alone never authorizes outbound SMS. START from that handset,
  // authenticated by Twilio's webhook signature, confirms possession/consent.
  await prisma.smsConsent.upsert({ where: { userId }, create: { userId, phone, consentAt: new Date(), source: "PENDING_HANDSET_CONFIRMATION" }, update: { phone, stoppedAt: null, consentAt: new Date(), source: "PENDING_HANDSET_CONFIRMATION" } });
  return { success: true };
}
export function verifyTwilioSignature(url: string, params: URLSearchParams, signature: string, token: string) {
  const data = url + [...new Set(params.keys())].sort().map(key => [...new Set(params.getAll(key))].sort().map(value => key + value).join("")).join("");
  const expected = Buffer.from(createHmac("sha1", token).update(data).digest("base64")), actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function handleSmsConsent(params: URLSearchParams) {
  const phone = params.get("From") ?? "", command = (params.get("OptOutType") ?? params.get("Body") ?? "").trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(command)) {
    await prisma.smsConsent.updateMany({ where: { phone }, data: { stoppedAt: new Date(), source: "HANDSET_STOP" } });
  } else if (["START", "UNSTOP"].includes(command)) {
    await prisma.smsConsent.updateMany({ where: { phone, source: "PENDING_HANDSET_CONFIRMATION", consentAt: { gt: new Date(Date.now() - 86400000) } }, data: { stoppedAt: null, consentAt: new Date(), source: "HANDSET_CONFIRMED" } });
  }
}
export async function deliverNoticeChannels() {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  // Twilio's Messages create endpoint does not provide the email provider's
  // replay key guarantee. A lost response is quarantined, never blindly resent.
  await prisma.channelDelivery.updateMany({ where: { state: "DISPATCHING", leaseUntil: { lt: new Date() } }, data: { state: "REVIEW", errorCode: "PROVIDER_OUTCOME_UNKNOWN", leaseToken: null } });
  const notices = await prisma.inboxNotice.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  for (const n of notices) {
    const pref = await prisma.noticePreference.findUnique({ where: { userId_category: { userId: n.userId, category: n.category } } });
    for (const channel of ["SMS", "PUSH"]) if (channel === "SMS" ? pref?.sms : pref?.push) await prisma.channelDelivery.upsert({ where: { noticeId_channel: { noticeId: n.id, channel } }, update: {}, create: { noticeId: n.id, userId: n.userId, channel, state: channel === "PUSH" ? "CONFIGURATION_REQUIRED" : "READY" } });
  }
  if (!sid || !token || !from) return { accepted: 0, configured: false };
  const jobs = await prisma.channelDelivery.findMany({ where: { state: "READY", channel: "SMS" }, take: 30 });
  let accepted = 0;
  for (const job of jobs) {
    const lease = randomUUID();
    const consent = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "userId" FROM "SmsConsent" WHERE "userId"=${job.userId} FOR UPDATE`;
      const c = await tx.smsConsent.findUnique({ where: { userId: job.userId } });
      const user = await tx.user.findUnique({ where: { id: job.userId } });
      if (!c || c.stoppedAt || c.source !== "HANDSET_CONFIRMED" || !user?.isActive) return null;
      const claim = await tx.channelDelivery.updateMany({ where: { id: job.id, state: "READY" }, data: { state: "DISPATCHING", attempts: { increment: 1 }, leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) } });
      return claim.count ? c : null;
    });
    if (!consent) continue;
    try {
      await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "userId" FROM "SmsConsent" WHERE "userId"=${job.userId} FOR UPDATE`;
      const current = await tx.smsConsent.findUniqueOrThrow({ where: { userId: job.userId } });
      if (current.stoppedAt || current.source !== "HANDSET_CONFIRMED" || current.phone !== consent.phone) {
        await tx.channelDelivery.updateMany({ where: { id: job.id, leaseToken: lease }, data: { state: "OPTED_OUT", leaseToken: null } }); return;
      }
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: consent.phone, From: from, Body: "Rent A 4Wheel: a private account update is waiting. Sign in to view it. Reply STOP to opt out." }), signal: AbortSignal.timeout(10000) });
      const result = await response.json() as { sid?: string; status?: string };
      const approved = response.ok && Boolean(result.sid) && ["accepted", "queued", "sending", "sent", "delivered"].includes(result.status ?? "");
      const saved = await tx.channelDelivery.updateMany({ where: { id: job.id, state: "DISPATCHING", leaseToken: lease, leaseUntil: { gt: new Date() } }, data: { state: approved ? "ACCEPTED" : response.status >= 400 && response.status < 500 ? "DEAD_LETTER" : "REVIEW", providerId: result.sid, errorCode: approved ? null : "PROVIDER_NOT_ACCEPTED", acceptedAt: approved ? new Date() : null, leaseToken: null } });
      if (approved) accepted += saved.count;
      }, { timeout: 15000 });
    } catch {
      await prisma.channelDelivery.updateMany({ where: { id: job.id, leaseToken: lease }, data: { state: "REVIEW", errorCode: "PROVIDER_OUTCOME_UNKNOWN", leaseToken: null } });
    }
  }
  return { accepted, configured: true };
}
