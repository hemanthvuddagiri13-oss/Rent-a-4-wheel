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
  onCheckoutComplete: () => void;
  onSuccess: () => void;
  onBack: () => void;
}

// Distinguishes a closed-admission rejection (paymentEligible:false — retrying
// the identical request will keep failing) from a transient error, so the UI
// can stop offering a same-request retry and point somewhere safe instead.
class CheckoutIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutIneligibleError";
  }
}

async function finalizeCheckout(reservationId: string, state: BookingState) {
  const res = await fetch(`/api/reservations/${reservationId}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      driver: state.driver satisfies DriverFormState,
      documentIds: state.documentIds,
      agreementAccepted: state.agreementAccepted,
      bookingFingerprint: state.bookingFingerprint,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : "Unable to complete checkout.";
    if (data.historicalCheckout === true && data.paymentEligible === false) throw new CheckoutIneligibleError(message);
    throw new Error(message);
  }
}

export function StepPayment({ state, onCheckoutComplete, onSuccess, onBack }: Props) {
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ineligible, setIneligible] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [outcome, setOutcome] = useState("processing");

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        setInitializing(true);
        const reservationId = state.reservationId;
        if (!reservationId) {
          throw new Error("We couldn't find your held reservation. Please go back and try again.");
        }

        const statusResponse = await fetch(`/api/reservations/${reservationId}/status`);
        if (!statusResponse.ok) throw new Error("Unable to access this reservation.");
        let checkoutComplete = state.checkoutComplete;
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          checkoutComplete = status.status !== "CHECKOUT_HOLD";
          if (checkoutComplete) onCheckoutComplete();
          if (status.outcome === "confirmed") { if (!cancelled) onSuccess(); return; }
          if (status.paidCents > 0 || !["CHECKOUT_HOLD", "AWAITING_PAYMENT"].includes(status.status)) {
            if (!cancelled) { setRecovering(true); setOutcome(status.outcome); }
            return;
          }
        }
        if (!checkoutComplete) { await finalizeCheckout(reservationId, state); onCheckoutComplete(); }

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
        if (cancelled) return;
        if (err instanceof CheckoutIneligibleError) setIneligible(err.message);
        else setError(err instanceof Error ? err.message : "Something went wrong.");
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

  async function recoverDeposit() {
    if (!state.reservationId) return;
    setConfirming(true); setError(null);
    try {
      const response = await fetch(`/api/reservations/${state.reservationId}/retry-deposit`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.requiresAction && data.clientSecret) {
        const client = await stripePromise;
        if (!client) throw new Error("Payment service unavailable");
        const result = await client.confirmCardPayment(data.clientSecret);
        if (result.error) throw new Error(result.error.message);
        await fetch(`/api/reservations/${state.reservationId}/retry-deposit`, { method: "POST" });
      }
      await refreshOutcome();
    } catch (e) { setError(e instanceof Error ? e.message : "Recovery pending"); }
    finally { setConfirming(false); }
  }
  async function refreshOutcome() {
    if (!state.reservationId) return;
    try {
      const response = await fetch(`/api/reservations/${state.reservationId}/status`);
      if (!response.ok) throw new Error("Unable to check reservation status");
      const data = await response.json(); setOutcome(data.outcome);
      if (data.outcome === "confirmed") onSuccess();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to check status"); }
  }

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
        <div role="status" className="mt-8 flex items-center gap-2 text-muted">
          <Loader2 className="h-5 w-5 animate-spin" /> Preparing secure checkout…
        </div>
      )}

      {ineligible && (
        <div role="alert" aria-live="assertive" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 p-5">
          <div className="flex items-center gap-2 text-red-400">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            <p className="font-semibold">Payment isn&apos;t currently available for this booking</p>
          </div>
          <p className="mt-2 text-sm text-silver">{ineligible}</p>
          <p className="mt-2 text-sm text-muted">Your original checkout details are retained. Trying again with the same information won&apos;t change this — check your account for the current status, or contact support.</p>
          <Button variant="outline" className="mt-4" onClick={onBack}>Back</Button>
        </div>
      )}

      {error && !ineligible && <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">{error}</p>}

      {!initializing && !ineligible && recovering && <div role="status" aria-live="polite" className="mt-6 space-y-3">
        <p>Reservation status: {outcome.replaceAll("_", " ")}. Your rental payment will not be submitted again.</p>
        {["payment_failed", "deposit_action_required"].includes(outcome) && <Button onClick={recoverDeposit} disabled={confirming}>Retry or authenticate security deposit</Button>}
        <Button variant="outline" onClick={refreshOutcome} disabled={confirming}>Check status</Button>
        <p className="text-sm text-muted">If deposit recovery cannot finish before the recovery deadline, the rental payment is queued for refund. A refund is complete only when the status says refunded.</p>
      </div>}
      {!initializing && !ineligible && devMode && (
        <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertTriangle className="h-5 w-5" />
            <p className="font-semibold">Development Mode</p>
          </div>
          <p className="mt-2 text-sm text-muted">
            This is a controlled test checkout. No real payment will be collected. Simulate a successful payment below to continue the test booking.
          </p>
          <Button className="mt-4" onClick={handleDevConfirm} disabled={confirming}>
            {confirming && <Loader2 className="h-4 w-4 animate-spin" />} Simulate Successful Payment
          </Button>
        </div>
      )}

      {!initializing && !ineligible && clientSecret && stripePromise && state.reservationId && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "night", variables: { colorPrimary: "#D4AF37" } } }}>
          <StripeCheckoutForm reservationId={state.reservationId} onSuccess={onSuccess} onPending={(value) => { setOutcome(value); setRecovering(true); setClientSecret(null); }} />
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

function StripeCheckoutForm({ reservationId, onSuccess, onPending }: { reservationId: string; onSuccess: () => void; onPending: (value: string) => void }) {
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

    try {
      const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: window.location.href } });
      if (confirmError) { setError(confirmError.message || "Payment failed"); return; }
      setProcessing(true);
      const outcome = await pollReservationOutcome(reservationId);
      if (outcome === "confirmed") onSuccess(); else onPending(outcome);
    } catch { onPending("processing"); }
    finally { setSubmitting(false); setProcessing(false); }
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
      {error && <p role="alert" aria-live="assertive" className="mt-3 text-sm text-red-400">{error}</p>}
      <Button type="submit" size="lg" className="mt-6 w-full" disabled={!stripe || submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Pay &amp; Reserve
      </Button>
    </form>
  );
}
