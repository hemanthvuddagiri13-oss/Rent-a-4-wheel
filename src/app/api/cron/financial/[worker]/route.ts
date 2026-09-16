import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { financialWorkers } from "@/lib/financial-workers";

export async function POST(req: NextRequest, context: { params: Promise<{ worker: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { worker } = await context.params;
  if (!Object.hasOwn(financialWorkers, worker)) return NextResponse.json({ error: "Unknown worker" }, { status: 404 });
  try {
    return NextResponse.json(await financialWorkers[worker as keyof typeof financialWorkers]());
  } catch {
    return NextResponse.json({ error: "Recovery failed; retry required" }, { status: 503 });
  }
}
export const GET = POST;
