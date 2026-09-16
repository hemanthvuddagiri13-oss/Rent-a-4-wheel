"use client";

import { useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { BookingState, BookingVehicle, BookingExtra, DriverFormState, UpdateBookingState } from "@/components/booking/types";

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

interface Props {
  vehicle: BookingVehicle;
  extras: BookingExtra[];
  state: BookingState;
  update: UpdateBookingState;
  onSuccess: () => void;
  onBack: () => void;
}

async function createReservation(vehicle: BookingVehicle, state: BookingState) {
  const res = await fetch("/api/reservations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicleId: vehicle.id,
      pickupAt: `${state.pickupDate}T${state.pickupTime}:00`,
      returnAt: `${state.returnDate}T${state.returnTime}:00`,
      extraIds: state.selectedExtraIds,
      couponCode: state.couponCode || undefined,
      driver: state.driver satisfies DriverFormState,
      documentIds: state.documentIds,
      agreementAccepted: state.agreementAccepted,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Unable to create reservation.");
  return data as { id: string; confirmationNumber: string };
}

export function StepPayment({ vehicle, state, update, onSuccess, onBack }: Props) {
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
        let reservationId = state.reservationId;
        let confirmationNumber = state.confirmationNumber;

        if (!reservationId) {
          const reservation = await createReservation(vehicle, state);
          reservationId = reservation.id;
          confirmationNumber = reservation.confirmationNumber;
          if (!cancelled) update({ reservationId, confirmationNumber });
        }

        const res = await fetch(`/api/reservations/${reservationId}/payment-intent`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to start payment.");

        if (cancelled) return;
        if (data.devMode) {
          setDevMode(true);
        } else {
          setClientSecret(data.clientSecret);
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

      {!initializing && clientSecret && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "night", variables: { colorPrimary: "#D4AF37" } } }}>
          <StripeCheckoutForm onSuccess={onSuccess} />
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

function StripeCheckoutForm({ onSuccess }: { onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
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
    onSuccess();
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
