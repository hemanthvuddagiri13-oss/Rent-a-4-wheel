import { NextRequest, NextResponse } from "next/server";
import { expireStaleReservations } from "@/lib/cleanup";

/**
 * Background job endpoint: expires checkout holds / awaiting-payment
 * reservations past their `expiresAt`. Wire this to a real scheduler in
 * production (e.g. Vercel Cron hitting this route every minute) — see
 * README "Background Jobs". Protected by a shared secret so it can't be
 * triggered by anyone who merely knows the URL.
 */
export async function POST(req: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== configuredSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await expireStaleReservations();
  return NextResponse.json(result);
}
