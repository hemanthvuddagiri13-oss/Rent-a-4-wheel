import { auth } from "@/auth";
import { acceptConditionReport } from "@/lib/condition-reports";
import { MarketplaceError } from "@/lib/marketplace";
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; reportId: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, reportId } = await ctx.params;
  try { return Response.json(await acceptConditionReport(session.user.id, id, reportId)); }
  catch (error) { return Response.json({ error: error instanceof MarketplaceError ? error.message : "Inspection unavailable." }, { status: error instanceof MarketplaceError ? error.status : 409 }); }
}
