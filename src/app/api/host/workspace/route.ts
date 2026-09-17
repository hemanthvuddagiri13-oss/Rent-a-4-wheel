import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { hostCommand, MarketplaceError, marketplaceLimit, saveHostProfile, saveListing } from "@/lib/marketplace";
import { safeLog } from "@/lib/safe-log";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  try {
    await marketplaceLimit(session.user.id);
    const data = await req.json();
    const result = data.action === "profile" ? await saveHostProfile(session.user.id, data)
      : data.action === "listing" ? await saveListing(session.user.id, data) : await hostCommand(session.user.id, data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MarketplaceError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError) return NextResponse.json({ error: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
    safeLog("HOST_WORKSPACE_FAILED", error);
    return NextResponse.json({ error: "Unable to save. Check the fields and try again." }, { status: 409 });
  }
}
