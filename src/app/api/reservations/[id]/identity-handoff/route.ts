import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getHostContext, hostOwnsReservation } from "@/lib/host-access";
import { marketplaceLimit } from "@/lib/marketplace";
import { handoffSchema } from "@/lib/validations/host-mobile";
import { recordIdentityHandoff } from "@/lib/identity-handoff";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const context = await getHostContext(session.user.id);
  if (!context || !await hostOwnsReservation(context, id)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const data = handoffSchema.safeParse(await req.json().catch(() => null));
  if (!data.success) return NextResponse.json({ error: data.error.flatten() }, { status: 400 });
  try {
    await marketplaceLimit(session.user.id);
    return NextResponse.json(await recordIdentityHandoff(session.user.id, id, data.data));
  } catch { return NextResponse.json({ error: "Identity evidence or pickup phase is unavailable." }, { status: 409 }); }
}
