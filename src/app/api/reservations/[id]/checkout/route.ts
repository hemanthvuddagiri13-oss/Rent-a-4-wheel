import { auth } from "@/auth";
import { checkoutReservation } from "@/lib/checkout-service";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return checkoutReservation(req, (await ctx.params).id, session.user.id);
}
