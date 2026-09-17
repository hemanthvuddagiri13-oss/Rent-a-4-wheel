import { auth } from "@/auth";
import { tripCommand, tripExperience } from "@/lib/trip-experience";
import { MarketplaceError, marketplaceLimit } from "@/lib/marketplace";
import { ReturnFinancialReviewError } from "@/lib/return-financial-authority";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json(await tripExperience(session.user.id, (await params).id), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return Response.json({ error: "Reservation unavailable." }, { status: error instanceof MarketplaceError ? error.status : 500 }); }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await marketplaceLimit(session.user.id);
    const { action } = await req.json();
    if (!["keys", "return", "complete"].includes(action)) return Response.json({ error: "Invalid action." }, { status: 400 });
    return Response.json(await tripCommand(session.user.id, (await params).id, action));
  } catch (error) { return Response.json({ error: error instanceof MarketplaceError || error instanceof ReturnFinancialReviewError ? error.message : "Unable to complete this action. Refresh and try again." }, { status: error instanceof MarketplaceError ? error.status : 409 }); }
}
