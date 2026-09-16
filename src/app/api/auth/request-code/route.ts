import { NextRequest, NextResponse } from "next/server";
import { requestAuthCode, getRequestIp } from "@/lib/auth-code";
import { requestCodeSchema } from "@/lib/validations/auth";

/**
 * Requests a six-digit sign-in code for an email address. Always returns a
 * generic success response regardless of whether the email belongs to an
 * existing account (account creation happens implicitly on first verified
 * sign-in) so this endpoint can't be used to enumerate registered emails.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = requestCodeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ip = getRequestIp(req.headers);
  const result = await requestAuthCode({ email: parsed.data.email, ip });

  if (!result.ok) {
    if (result.reason === "cooldown") {
      return NextResponse.json(
        { error: `Please wait ${result.retryAfterSeconds}s before requesting another code.` },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: "Too many code requests. Please try again later." }, { status: 429 });
  }

  return NextResponse.json({ success: true, devCode: result.devCode });
}
