import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type { SecurityDeposit } from "@prisma/client";

// Conservative estimate of how long Stripe holds an uncaptured manual
// PaymentIntent authorization before automatically releasing it. Stripe
// does not expose an exact, guaranteed expiration timestamp via the API —
// the real window depends on the card network (commonly ~7 days) — so
// this is deliberately conservative (shorter than the shortest common
// network window) and paired with `payment_intent.canceled` webhook
// handling for the authoritative release moment.
const AUTHORIZATION_VALIDITY_DAYS = 6;

export function computeAuthorizationExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + AUTHORIZATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}

/** A Stripe-side error that is transient (network blip, rate limit, Stripe
 * API hiccup) rather than a genuine decline/validation failure. */
export function isTransientStripeError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err.type === "StripeConnectionError" ||
    err.type === "StripeAPIError" ||
    err.type === "StripeRateLimitError" ||
    err.code === "rate_limit"
  );
}

export type DepositAuthorizationOutcome =
  | { outcome: "not_required" }
  | { outcome: "already_valid" }
  | { outcome: "succeeded"; depositIntentId: string; authorizedAt: Date; authorizationExpiresAt: Date }
  | { outcome: "failed"; failureReason: string };

/**
 * Attempts to place a manual-capture (authorization-only) hold for a
 * reservation's security deposit, off-session, on the same payment method
 * the customer just used for the rental charge.
 *
 * A resolved Stripe API call is NOT by itself proof of a valid
 * authorization — this explicitly checks the returned PaymentIntent's
 * `status` is `requires_capture` (the correct "authorized, not yet
 * captured" state) before reporting success; anything else (including a
 * call that resolves without throwing) is treated as a failure with a
 * descriptive reason.
 *
 * Throws (does not return `{outcome:"failed"}`) for transient Stripe
 * errors (network/API/rate-limit) — callers must let these propagate so
 * the webhook ledger retries rather than recording a permanent decline.
 */
export async function attemptDepositAuthorization(
  reservation: { id: string; deposit: SecurityDeposit | null },
  intent: Stripe.PaymentIntent
): Promise<DepositAuthorizationOutcome> {
  if (!reservation.deposit) return { outcome: "not_required" };
  if (reservation.deposit.status === "SUCCEEDED" && reservation.deposit.authorizationExpiresAt && reservation.deposit.authorizationExpiresAt > new Date()) {
    return { outcome: "already_valid" };
  }
  if (reservation.deposit.status !== "REQUIRES_PAYMENT" && reservation.deposit.status !== "FAILED") {
    return { outcome: "not_required" };
  }
  if (!stripe) return { outcome: "not_required" };

  const paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
  const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (!paymentMethodId) return { outcome: "failed", failureReason: "No payment method available to authorize the security deposit." };

  let depositIntent: Stripe.PaymentIntent;
  try {
    depositIntent = await stripe.paymentIntents.create(
      {
        amount: reservation.deposit.amountCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        capture_method: "manual",
        confirm: true,
        off_session: true,
        metadata: { reservationId: reservation.id, purpose: "security_deposit" },
      },
      { idempotencyKey: `deposit-${reservation.id}` }
    );
  } catch (err) {
    if (isTransientStripeError(err)) throw err;
    const failureReason = err instanceof Error ? err.message : "Deposit authorization failed.";
    return { outcome: "failed", failureReason };
  }

  if (depositIntent.status !== "requires_capture") {
    // A resolved call is not proof of a valid hold — anything other than
    // "requires_capture" (e.g. "requires_action" for 3DS, "processing")
    // means we do NOT actually have an authorization yet.
    return {
      outcome: "failed",
      failureReason: `Deposit PaymentIntent resolved with unexpected status "${depositIntent.status}" (expected requires_capture).`,
    };
  }

  const authorizedAt = new Date();
  return {
    outcome: "succeeded",
    depositIntentId: depositIntent.id,
    authorizedAt,
    authorizationExpiresAt: computeAuthorizationExpiresAt(authorizedAt),
  };
}

/**
 * Applies a `payment_intent.canceled` webhook for a deposit-purpose
 * PaymentIntent: Stripe auto-released an uncaptured authorization (or it
 * was explicitly canceled). Marks the deposit CANCELLED so trip-start
 * (which requires a currently-valid authorization) correctly blocks until
 * it is re-authorized.
 */
export async function handleDepositAuthorizationCanceled(intent: Stripe.PaymentIntent): Promise<void> {
  if (intent.metadata?.purpose !== "security_deposit") return;
  const deposit = await prisma.securityDeposit.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!deposit || deposit.status !== "SUCCEEDED") return;

  await prisma.securityDeposit.update({
    where: { id: deposit.id },
    data: { status: "CANCELLED", stripeStatus: intent.status },
  });
}
