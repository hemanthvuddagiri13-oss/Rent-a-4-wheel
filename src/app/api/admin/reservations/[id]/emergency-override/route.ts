import { safeLog } from "@/lib/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getRequestIp } from "@/lib/auth-code";
import { performEmergencyOverride, EmergencyOverrideError, type EmergencyOverrideAction } from "@/lib/emergency-override";

const schema = z.object({
  action: z.enum(["FORCE_START_TRIP", "FORCE_COMPLETE_TRIP"]),
  reason: z.string().min(1),
  stepUpCode: z.string().length(6),
  confirm: z.literal(true),
});

/**
 * SUPER_ADMIN-only emergency override endpoint. Never linked from ordinary
 * admin UI — this is a deliberately narrow, heavily-audited escape hatch,
 * not a replacement for the customer/host self-serve trip-start gate. See
 * src/lib/emergency-override.ts for every requirement this enforces.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await performEmergencyOverride({
      actorId: session.user.id,
      actorRole: session.user.role,
      actorEmail: session.user.email,
      reservationId: id,
      action: parsed.data.action as EmergencyOverrideAction,
      reason: parsed.data.reason,
      stepUpCode: parsed.data.stepUpCode,
      confirm: parsed.data.confirm,
      ip: getRequestIp(req.headers),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EmergencyOverrideError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    safeLog("EMERGENCY_OVERRIDE_FAILED", err);
    return NextResponse.json({ error: "Something went wrong performing the override." }, { status: 500 });
  }
}

// A SUPER_ADMIN must request their own step-up code before calling POST
// above (the `stepUpCode` field) — reuses the same email-code mechanism as
// ordinary sign-in (POST /api/auth/request-code with their own account
// email), requested fresh immediately before the override.
