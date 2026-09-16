import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const secretKey = process.env.STRIPE_SECRET_KEY;

export const stripe = secretKey ? new Stripe(secretKey) : null;

export function isStripeConfigured(): boolean {
  return Boolean(stripe && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
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
