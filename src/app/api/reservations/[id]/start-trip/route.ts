import { auth } from "@/auth";
import { startCustomerTrip, TripStartBlockedError } from "@/lib/customer-reservation";
import { MarketplaceError } from "@/lib/marketplace";
import { safeLog } from "@/lib/safe-log";
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try { return Response.json(await startCustomerTrip(session.user.id, id)); }
  catch (error) {
    if (error instanceof TripStartBlockedError) return Response.json({ error: error.message, reasons: error.reasons }, { status: error.status });
    if (error instanceof MarketplaceError) return Response.json({ error: error.message }, { status: error.status });
    safeLog("CUSTOMER_RESERVATION_ACTION_FAILED", error);
    return Response.json({ error: "Reservation unavailable. Refresh and try again." }, { status: 409 });
  }
}
