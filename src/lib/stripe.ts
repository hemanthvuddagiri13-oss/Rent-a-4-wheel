import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;

export const stripe = secretKey ? new Stripe(secretKey) : null;

export function isStripeConfigured(): boolean {
  return Boolean(stripe && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}
