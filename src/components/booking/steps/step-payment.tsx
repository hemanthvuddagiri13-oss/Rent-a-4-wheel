"use client";

import { useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { BookingState, DriverFormState } from "@/components/booking/types";

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

interface Props {
  state: BookingState;
  onSuccess: () => void;
  onBack: () => void;
}

async function finalizeCheckout(reservationId: string, state: BookingState) {
  const res = await fetch(`/api/reservations/${reservationId}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      driver: state.driver satisfies DriverFormState,
      documentIds: state.documentIds,
      agreementAccepted: state.agreementAccepted,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Unable to complete checkout.");
}

export function StepPayment({ state, onSuccess, onBack }: Props) {
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        setInitializing(true);
        const reservationId = state.reservationId;
        if (!reservationId) {
          throw new Error("We couldn't find your held reservation. Please go back and try again.");
        }

        await finalizeCheckout(reservationId, state);

        const res = await fetch(`/api/reservations/${reservationId}/payment-intent`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to start payment.");

        if (cancelled) return;
        if (data.devMode) {
          setDevMode(true);
        } else if (data.clientSecret) {
          setClientSecret(data.clientSecret);
        } else {
          throw new Error("Payments are not available in this environment.");
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDevConfirm() {
    if (!state.reservationId) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/reservations/${state.reservationId}/confirm-dev-payment`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to confirm payment.");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Payment</h2>
      <p className="mt-1 text-sm text-muted">
        Total due today: <span className="text-gold-bright font-semibold">{state.breakdown ? formatCurrency(state.breakdown.totalCents) : "—"}</span>
      </p>

      {initializing && (
        <div className="mt-8 flex items-center gap-2 text-muted">
          <Loader2 className="h-5 w-5 animate-spin" /> Preparing secure checkout…
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {!initializing && devMode && (
        <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertTriangle className="h-5 w-5" />
            <p className="font-semibold">Development Mode</p>
          </div>
          <p className="mt-2 text-sm text-muted">
            Stripe API keys are not configured in this environment, so real payments can&apos;t be processed. Add
            <code className="mx-1 rounded bg-white/10 px-1.5 py-0.5 text-xs">STRIPE_SECRET_KEY</code>
            and
            <code className="mx-1 rounded bg-white/10 px-1.5 py-0.5 text-xs">NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>
            to enable live payments. You can simulate a successful payment below to continue testing the booking flow.
          </p>
          <Button className="mt-4" onClick={handleDevConfirm} disabled={confirming}>
            {confirming && <Loader2 className="h-4 w-4 animate-spin" />} Simulate Successful Payment
          </Button>
        </div>
      )}

      {!initializing && clientSecret && stripePromise && state.reservationId && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "night", variables: { colorPrimary: "#D4AF37" } } }}>
          <StripeCheckoutForm reservationId={state.reservationId} onSuccess={onSuccess} />
        </Elements>
      )}

      <div className="mt-6 flex items-center gap-2 text-xs text-muted">
        <ShieldCheck className="h-4 w-4 text-gold" /> Payments are processed securely by Stripe. We never store your card details.
      </div>

      <Button variant="outline" className="mt-6" onClick={onBack} disabled={initializing || confirming}>
        Back
      </Button>
    </div>
  );
}

const STATUS_POLL_INTERVAL_MS = 1500;
const STATUS_POLL_TIMEOUT_MS = 45_000;

type ReservationOutcome = "processing" | "confirmed" | "payment_failed" | "refunded" | "expired" | "cancelled";

async function pollReservationOutcome(reservationId: string): Promise<ReservationOutcome> {
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`/api/reservations/${reservationId}/status`);
    if (res.ok) {
      const data = await res.json();
      if (data.outcome !== "processing") return data.outcome as ReservationOutcome;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  return "processing";
}

function StripeCheckoutForm({ reservationId, onSuccess }: { reservationId: string; onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  // Client-side confirmation only proves the PaymentIntent reached a
  // confirmable state, not that the webhook has finished persisting the
  // rental payment, authorizing the deposit, and confirming the
  // reservation server-side. We must keep showing "Processing" — never
  // "Confirmed" — until the server itself reports a terminal outcome.
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });

    setSubmitting(false);
    if (confirmError) {
      setError(confirmError.message || "Payment failed. Please try again.");
      return;
    }

    setProcessing(true);
    const outcome = await pollReservationOutcome(reservationId);
    setProcessing(false);

    switch (outcome) {
      case "confirmed":
        onSuccess();
        return;
      case "payment_failed":
        setError("We couldn't authorize your security deposit. Please try a different payment method.");
        return;
      case "refunded":
        setError("Your payment could not be completed in time and has been automatically refunded.");
        return;
      case "expired":
        setError("Your checkout window expired. Please start again.");
        return;
      case "cancelled":
        setError("This reservation was cancelled.");
        return;
      default:
        setError("Your payment is still being processed. We'll email you a confirmation shortly.");
    }
  }

  if (processing) {
    return (
      <div className="mt-6 flex items-center gap-2 text-muted">
        <Loader2 className="h-5 w-5 animate-spin" /> Processing your payment — do not close this page…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6">
      <PaymentElement />
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <Button type="submit" size="lg" className="mt-6 w-full" disabled={!stripe || submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Pay &amp; Reserve
      </Button>
    </form>
  );
}
