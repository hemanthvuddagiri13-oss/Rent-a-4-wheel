import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { authenticateMobile, MobileError } from "./auth";
import { mobileReservationAccess } from "./queries";
import { isStripeConfigured } from "@/lib/stripe";

/** A location, never a credential or a payment operation. The browser must
 * independently authenticate and all web/domain gates run again there. */
export async function trialRead(req: Request, id: string, action: string) {
  const actor = await authenticateMobile(req.headers);
  const result = await prisma.$transaction(async tx => {
    await mobileReservationAccess(tx, actor.userId, id, true);
    if (action === "web-payment") return {
      path: `/account/reservations/${encodeURIComponent(id)}`,
      authentication: "INDEPENDENT_WEB_SESSION" as const,
      confirmsPayment: false as const,
      provider: isStripeConfigured() ? "TEST_CONFIGURED" as const : "UNAVAILABLE" as const,
    };
    const agreement = await tx.agreementAcceptance.findFirst({ where: { reservationId: id, type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, select: { id: true, documentVersion: true, contentHash: true, contentSnapshot: true, signedAt: true, signedPdfStorageKey: true } });
    if (!agreement) return { agreement: null };
    if (createHash("sha256").update(agreement.contentSnapshot).digest("hex") !== agreement.contentHash) throw new MobileError("UNAVAILABLE", 503);
    const { signedPdfStorageKey, ...frozen } = agreement;
    return { agreement: { ...frozen, pdfAvailable: Boolean(signedPdfStorageKey), browserPath: `/account/reservations/${encodeURIComponent(id)}#signed-agreement` } };
  });
  await authenticateMobile(req.headers);
  return result;
}
