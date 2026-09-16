"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/utils";
import type { BookingExtra, BookingState, BookingVehicle, UpdateBookingState } from "@/components/booking/types";

interface Props {
  vehicle: BookingVehicle;
  extras: BookingExtra[];
  state: BookingState;
  update: UpdateBookingState;
  onNext: () => void;
  onBack: () => void;
}

export function StepReview({ vehicle, extras, state, update, onNext, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState(state.couponCode);
  const [couponMessage, setCouponMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchQuote() {
      const pickupAt = `${state.pickupDate}T${state.pickupTime}:00`;
      const returnAt = `${state.returnDate}T${state.returnTime}:00`;
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/vehicles/${vehicle.id}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pickupAt, returnAt, extraIds: state.selectedExtraIds, couponCode: state.couponCode || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to calculate pricing.");
        const held = await fetch("/api/reservations/hold", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vehicleId: vehicle.id, pickupAt, returnAt, extraIds: state.selectedExtraIds, couponCode: state.couponCode || undefined }) });
        const hold = await held.json();
        if (!held.ok) throw new Error(hold.error || "Unable to update reservation");
        if (cancelled) return;
        update({ reservationId: hold.id, confirmationNumber: hold.confirmationNumber, holdExpiresAt: hold.expiresAt, bookingFingerprint: hold.bookingFingerprint });
        update({ breakdown: hold.breakdown });
        setCouponMessage(data.couponError || (data.couponApplied ? "Coupon applied!" : null));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to calculate pricing.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchQuote();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle.id, state.pickupDate, state.pickupTime, state.returnDate, state.returnTime, state.selectedExtraIds, state.couponCode]);

  const selectedExtras = extras.filter((e) => state.selectedExtraIds.includes(e.id));

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Review Your Booking</h2>

      <div className="mt-6 space-y-6 rounded-xl border border-white/10 bg-card p-5">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Vehicle</h3>
          <p className="mt-1 font-medium text-white">
            {vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted">Pickup</h3>
            <p className="mt-1 text-sm text-white">
              {state.pickupDate} at {state.pickupTime}
            </p>
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted">Return</h3>
            <p className="mt-1 text-sm text-white">
              {state.returnDate} at {state.returnTime}
            </p>
          </div>
        </div>
        {selectedExtras.length > 0 && (
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted">Extras</h3>
            <ul className="mt-1 text-sm text-white">
              {selectedExtras.map((e) => (
                <li key={e.id}>{e.name}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Driver</h3>
          <p className="mt-1 text-sm text-white">
            {state.driver.firstName} {state.driver.lastName} &middot; {state.driver.email}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <label htmlFor="coupon" className="text-xs uppercase tracking-wide text-muted">
          Promo Code
        </label>
        <div className="mt-1.5 flex gap-2">
          <Input id="coupon" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Enter code" />
          <Button type="button" variant="outline" onClick={() => update({ couponCode: couponInput })}>
            Apply
          </Button>
        </div>
        {couponMessage && <p className="mt-2 text-sm text-muted">{couponMessage}</p>}
      </div>

      <div className="mt-6 rounded-xl border border-gold/20 bg-card p-5">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Calculating final pricing…
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {state.breakdown && !loading && (
          <div className="space-y-2 text-sm">
            <Row label={`Rental (${state.breakdown.units} × ${state.breakdown.rateType.toLowerCase()})`} value={formatCurrency(state.breakdown.subtotalCents)} />
            {state.breakdown.extrasCents > 0 && <Row label="Extras" value={formatCurrency(state.breakdown.extrasCents)} />}
            {state.breakdown.discountCents > 0 && (
              <Row label="Discount" value={`-${formatCurrency(state.breakdown.discountCents)}`} className="text-emerald-400" />
            )}
            <Row label="Taxes" value={formatCurrency(state.breakdown.taxCents)} />
            {state.breakdown.feesCents > 0 && <Row label="Fees" value={formatCurrency(state.breakdown.feesCents)} />}
            <Separator className="my-2" />
            <Row label="Total" value={formatCurrency(state.breakdown.totalCents)} bold />
            {state.breakdown.depositCents > 0 && (
              <Row label="Security Deposit (authorized separately)" value={formatCurrency(state.breakdown.depositCents)} muted />
            )}
          </div>
        )}
      </div>

      <label className="mt-6 flex items-start gap-3 rounded-xl border border-white/10 bg-card p-4">
        <Checkbox checked={state.agreementAccepted} onCheckedChange={(v) => update({ agreementAccepted: v === true })} className="mt-0.5" />
        <span className="text-sm text-silver">
          I have read and agree to the{" "}
          <Link href="/legal/rental-agreement" target="_blank" className="text-gold hover:underline">
            Rental Agreement
          </Link>{" "}
          and{" "}
          <Link href="/legal/terms-and-conditions" target="_blank" className="text-gold hover:underline">
            Terms &amp; Conditions
          </Link>
          .
        </span>
      </label>

      <div className="mt-8 flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button size="lg" disabled={!state.breakdown || !state.agreementAccepted || loading || Boolean(error)} onClick={onNext}>
          Continue to Payment
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, bold, muted, className }: { label: string; value: string; bold?: boolean; muted?: boolean; className?: string }) {
  return (
    <div
      className={
        "flex justify-between " +
        (bold ? "font-display text-base font-semibold text-white" : muted ? "text-xs text-muted" : "text-silver") +
        (className ? " " + className : "")
      }
    >
      <span>{label}</span>
      <span className={bold ? "text-gold-bright" : ""}>{value}</span>
    </div>
  );
}
