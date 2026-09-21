"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, cn } from "@/lib/utils";
import type { PricingBreakdown } from "@/lib/pricing";

function defaultDate(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

export function BookingWidget({ vehicleId, dailyRateCents }: { vehicleId: string; dailyRateCents: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [pickupDate, setPickupDate] = useState(searchParams.get("pickupDate") || defaultDate(1));
  const [pickupTime, setPickupTime] = useState(searchParams.get("pickupTime") || "10:00");
  const [returnDate, setReturnDate] = useState(searchParams.get("returnDate") || defaultDate(4));
  const [returnTime, setReturnTime] = useState(searchParams.get("returnTime") || "10:00");

  const [breakdown, setBreakdown] = useState<PricingBreakdown | null>(null);
  const [taxWarning,setTaxWarning]=useState<string|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchQuote() {
      const pickupAt = `${pickupDate}T${pickupTime}:00`;
      const returnAt = `${returnDate}T${returnTime}:00`;
      if (new Date(returnAt) <= new Date(pickupAt)) {
        setError("Return date/time must be after pickup.");
        setBreakdown(null);
        return;
      }
      setError(null);
      setLoading(true);

      try {
        const res = await fetch(`/api/vehicles/${vehicleId}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pickupAt, returnAt, extraIds: [] }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to calculate pricing.");
        setBreakdown(data.breakdown);setTaxWarning(data.taxWarning??null);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
          setBreakdown(null);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchQuote();
    return () => controller.abort();
  }, [vehicleId, pickupDate, pickupTime, returnDate, returnTime]);

  function handleContinue() {
    const params = new URLSearchParams({
      pickupDate,
      pickupTime,
      returnDate,
      returnTime,
    });
    router.push(`/book/${vehicleId}?${params.toString()}`);
  }

  return (
    <div id="book" className="sticky top-24 rounded-xl border border-gold/20 bg-card p-6 shadow-xl">
      <p className="font-display text-lg font-semibold text-white">Reserve This Vehicle</p>
      <p className="mt-1 text-sm text-muted">From {formatCurrency(dailyRateCents)}/day</p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="w-pickup-date">Pickup Date</Label>
          <input
            id="w-pickup-date"
            type="date"
            value={pickupDate}
            min={defaultDate(0)}
            onChange={(e) => setPickupDate(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-surface px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="w-pickup-time">Time</Label>
          <input
            id="w-pickup-time"
            type="time"
            value={pickupTime}
            onChange={(e) => setPickupTime(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-surface px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="w-return-date">Return Date</Label>
          <input
            id="w-return-date"
            type="date"
            value={returnDate}
            min={pickupDate}
            onChange={(e) => setReturnDate(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-surface px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="w-return-time">Time</Label>
          <input
            id="w-return-time"
            type="time"
            value={returnTime}
            onChange={(e) => setReturnTime(e.target.value)}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-surface px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
      </div>

      <Separator className="my-5" />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading && !error && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Calculating pricing…
        </div>
      )}

      {breakdown && !loading && !error && (
        <div className={cn("space-y-2 text-sm")}>
          <div className="flex justify-between text-silver">
            <span>
              Rental ({breakdown.units} × {breakdown.rateType.toLowerCase()})
            </span>
            <span>{formatCurrency(breakdown.subtotalCents)}</span>
          </div>
          {breakdown.taxCents > 0 && (
            <div className="flex justify-between text-muted">
              <span>Taxes</span>
              <span>{formatCurrency(breakdown.taxCents)}</span>
            </div>
          )}
          {taxWarning&&<p className="text-xs text-amber-200">{taxWarning}</p>}
          {breakdown.feesCents > 0 && (
            <div className="flex justify-between text-muted">
              <span>Fees</span>
              <span>{formatCurrency(breakdown.feesCents)}</span>
            </div>
          )}
          {breakdown.discountCents > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Discount</span>
              <span>-{formatCurrency(breakdown.discountCents)}</span>
            </div>
          )}
          <Separator className="my-2" />
          <div className="flex justify-between font-display text-base font-semibold text-white">
            <span>Total</span>
            <span className="text-gold-bright">{formatCurrency(breakdown.totalCents)}</span>
          </div>
          {breakdown.depositCents > 0 && (
            <div className="flex justify-between text-xs text-muted">
              <span>Security deposit (authorized separately)</span>
              <span>{formatCurrency(breakdown.depositCents)}</span>
            </div>
          )}
        </div>
      )}

      <Button className="mt-6 w-full text-base" size="lg" disabled={!breakdown || loading} onClick={handleContinue}>
        Continue to Book
      </Button>

      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted">
        <ShieldCheck className="h-3.5 w-3.5 text-gold" /> No charge yet — review every detail before you pay.
      </p>
    </div>
  );
}
