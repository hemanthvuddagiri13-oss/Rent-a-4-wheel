import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const secretKey = process.env.STRIPE_SECRET_KEY;

export const stripe = secretKey ? new Stripe(secretKey) : null;

export function isStripeConfigured(): boolean {
  return Boolean(stripe && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

/**
 * True if ANY Stripe key/configuration is present, even partially (e.g.
 * only a secret key with no publishable key yet, or only a webhook
 * secret). Unlike `isStripeConfigured()` — which requires a *complete*
 * client+server pair before real payments are attempted — this is
 * deliberately the more paranoid check used to gate the dev-only payment
 * simulation endpoint: a half-configured Stripe account is still real
 * Stripe configuration, and simulation must refuse to run rather than
 * silently coexist with it.
 */
export function hasAnyStripeConfiguration(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_WEBHOOK_SECRET
  );
}

/**
 * Gate for the dev-only "simulate successful payment" endpoint. Requires
 * ALL of:
 *  - explicit local-development opt-in (`ALLOW_DEV_PAYMENT_SIMULATION=true`)
 *  - `NODE_ENV === "development"` (never production, staging, or test —
 *    a deployed staging environment must set NODE_ENV accordingly and
 *    never this opt-in flag)
 *  - no Stripe configuration present at all, even partial
 */
export function isDevPaymentSimulationAllowed(): boolean {
  return process.env.ALLOW_DEV_PAYMENT_SIMULATION === "true" && process.env.NODE_ENV === "development" && !hasAnyStripeConfiguration();
}

/**
 * Returns the Stripe Customer ID for a user, creating (and persisting) one
 * on first use. Every rental/deposit PaymentIntent for a user is attached
 * to the same Stripe Customer so saved payment methods and the off-session
 * deposit authorization (see the webhook handler) can reuse the payment
 * method the customer already confirmed with.
 */
export async function ensureStripeCustomer(user: { id: string; email: string | null; name: string | null; stripeCustomerId: string | null }): Promise<string> {
  if (!stripe) throw new Error("Stripe is not configured.");
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });

  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}
