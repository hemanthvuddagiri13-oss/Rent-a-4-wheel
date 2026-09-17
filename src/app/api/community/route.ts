import { requestAuthCode } from "@/lib/auth-code";
import { requestSmsConsent } from "@/lib/notice-channels";
import { communityAdmin } from "@/lib/community-admin";
import { auth } from "@/auth";
import { z, ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { MarketplaceError, marketplaceLimit, marketplaceActor } from "@/lib/marketplace";
import { openConversation, messageCommand } from "@/lib/conversations";
import { createServiceCase, caseCommand } from "@/lib/service-cases";
import { saveTripReview, moderateTripReview } from "@/lib/trip-reviews";
import { uploadCollaborationFile } from "@/lib/collaboration-files";
import { safeLog } from "@/lib/safe-log";
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (req.headers.get("origin") !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const userId = session.user.id;
    await marketplaceActor(prisma, userId); await marketplaceLimit(userId);
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      if (Number(req.headers.get("content-length") ?? 0) > 9 * 1024 * 1024) throw new MarketplaceError("File too large.", 413);
      const form = await req.formData(), file = form.get("file");
      if (!(file instanceof File)) throw new MarketplaceError("Choose an image.");
      return Response.json(await uploadCollaborationFile(userId, { conversationId: String(form.get("conversationId") || "") || undefined, caseId: String(form.get("caseId") || "") || undefined }, file, String(form.get("purpose") || "MESSAGE")));
    }
    const data = await req.json();
    let result: unknown;
    switch (data.action) {
      case "stepUp": { const actor = await marketplaceActor(prisma, userId); if (actor.role !== "SUPER_ADMIN") throw new MarketplaceError("Forbidden.", 403); const issued = await requestAuthCode({ email: actor.email, ip: null, purpose: "EMERGENCY_OVERRIDE_STEP_UP" }); if (!issued.ok) throw new MarketplaceError("Wait before requesting another code.", 429); result = { success: true }; break; }
      case "admin": result = await communityAdmin(userId, data); break;
      case "conversation": result = await openConversation(userId, z.object({ reservationId: z.string().optional(), vehicleId: z.string().optional() }).parse(data)); break;
      case "message": result = await messageCommand(userId, z.string().parse(data.id), z.object({ action: z.enum(["send", "edit", "delete", "read", "report"]), body: z.string().optional(), messageId: z.string().optional(), version: z.coerce.number().int().optional() }).parse({ ...data, action: data.command })); break;
      case "case": result = await createServiceCase(userId, { ...data, reservationId: data.reservationId || undefined, linkedCaseId: data.linkedCaseId || undefined, originalPhotoIds: data.originalPhotoIds || [] }); break;
      case "caseCommand": result = await caseCommand(userId, z.string().parse(data.id), { ...data, action: data.command }); break;
      case "review": result = await saveTripReview(userId, data); break;
      case "moderate": result = await moderateTripReview(userId, z.string().parse(data.id), z.enum(["hide", "restore", "report"]).parse(data.command), z.string().parse(data.reason)); break;
      case "smsConsent": result = await requestSmsConsent(userId, z.string().parse(data.phone), data.consent === "yes"); break;
      case "preference": {
        const p = z.object({ category: z.enum(["MESSAGE", "CLAIM", "DISPUTE", "INCIDENT", "TICKET", "REVIEW", "BOOKING", "PAYMENT"]), email: z.enum(["on", "off"]), sms: z.enum(["on", "off"]).default("off"), push: z.enum(["on", "off"]).default("off") }).parse(data);
        result = await prisma.noticePreference.upsert({ where: { userId_category: { userId, category: p.category } }, create: { userId, category: p.category, email: p.email === "on", sms: p.sms === "on", push: p.push === "on" }, update: { email: p.email === "on", sms: p.sms === "on", push: p.push === "on" } }); break;
      }
      case "privacy": result = await prisma.privacyDeletion.create({ data: { userId } }); break;
      default: throw new MarketplaceError("Unknown action.");
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof MarketplaceError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError) return Response.json({ error: "Check the required fields and try again." }, { status: 400 });
    safeLog("COMMUNITY_ACTION_FAILED", error);
    return Response.json({ error: "Unable to save. The record may have changed; refresh and try again." }, { status: 409 });
  }
}
