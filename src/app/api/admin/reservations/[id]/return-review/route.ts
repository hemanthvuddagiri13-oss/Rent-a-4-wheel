import { auth } from "@/auth";
import { canManageSettings } from "@/lib/rbac";
import { withReservationLock } from "@/lib/financial-locks";
import { marketplaceActor, marketplaceLimit, MarketplaceError } from "@/lib/marketplace";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { planAllDepositReleases } from "@/lib/deposit-release-plan";
import { z } from "zod";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || !canManageSettings(session.user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    await marketplaceLimit(session.user.id);
    const { id } = await params;
    const data = z.object({ action: z.enum(["REVIEW", "COMPLETE_NO_CHARGE"]), reason: z.string().trim().min(10).max(2000) }).parse(await req.json());
    await withReservationLock(id, async tx => {
      const actor = await marketplaceActor(tx, session.user.id);
      if (!canManageSettings(actor.role)) throw new MarketplaceError("Forbidden", 403);
      const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { trip: true } });
      if (!["DISPUTED", "UNDER_CLAIM_REVIEW"].includes(r.status) || !r.trip?.endedAt) throw new MarketplaceError("Only ended trips awaiting damage review can use this action.", 409);
      if (data.action === "REVIEW") {
        if (r.status === "DISPUTED") await transitionReservation(tx, { id, from: "DISPUTED", to: "UNDER_CLAIM_REVIEW" });
      } else {
        if (r.financialDisposition === "REVIEW") throw new MarketplaceError("Resolve the financial case before releasing the deposit.", 409);
        await transitionReservation(tx, { id, from: r.status, to: "COMPLETED", data: { financialDisposition: "TERMINATED" } });
        await planAllDepositReleases(tx, id);
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: `return-review.${data.action}`, entityType: "Reservation", entityId: id, metadata: { reason: data.reason } } });
      await tx.tripEvent.create({ data: { actorId: actor.id, reservationId: id, type: `RETURN_${data.action}` } });
    });
    return Response.json({ success: true });
  } catch (error) { return Response.json({ error: error instanceof MarketplaceError ? error.message : "Unable to record the return decision." }, { status: error instanceof MarketplaceError ? error.status : 409 }); }
}
