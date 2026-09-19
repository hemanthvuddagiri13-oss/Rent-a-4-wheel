import { safeFinanceEvent } from "@/lib/finance-webhooks";
import { safeLog } from "@/lib/safe-log";
import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { stripe } from "@/lib/stripe";
import { claimStripeEventForProcessing } from "@/lib/stripe-event-ledger";
import { dispatchClaimedStripeEvent } from "@/lib/stripe-event-dispatch";

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    safeLog("STRIPE_WEBHOOK_SIGNATURE_VERIFICATION_FAILED", err);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  event = safeFinanceEvent(event);
  const claim = await claimStripeEventForProcessing({
    stripeEventId: event.id,
    type: event.type,
    payload: event as unknown as Prisma.InputJsonValue,
  });

  if (!claim.shouldProcess) {
    // Either already fully processed (true duplicate — no-op) or another
    // in-flight request is handling it right now (not stale yet). Either
    // way, tell Stripe we're done; it should not treat this as a failure.
    return NextResponse.json({ received: true, claimed: false, reason: claim.reason });
  }

  const result = await dispatchClaimedStripeEvent({ eventRecordId: claim.eventRecordId, leaseToken: claim.leaseToken, event });

  if (!result.ok) {
    // Do NOT swallow this and return 200 — a non-2xx response tells
    // Stripe to retry per its own schedule, on top of our own ledger
    // making the next delivery (or a manual replay) retryable rather than
    // a rejected duplicate.
    return NextResponse.json({ error: "Processing failed; will retry." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
