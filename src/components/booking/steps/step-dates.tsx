"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { BookingState, UpdateBookingState } from "@/components/booking/types";

interface Props {
  state: BookingState;
  update: UpdateBookingState;
  onNext: () => void;
  onBack: () => void;
  error: string | null;
}

export function StepDates({ state, update, onNext, onBack, error }: Props) {
  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Select Your Dates</h2>
      <p className="mt-1 text-sm text-muted">We&apos;ll check live availability for these dates.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="b-pickup-date">Pickup Date</Label>
          <input
            id="b-pickup-date"
            type="date"
            value={state.pickupDate}
            onChange={(e) => update({ pickupDate: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="b-pickup-time">Pickup Time</Label>
          <input
            id="b-pickup-time"
            type="time"
            value={state.pickupTime}
            onChange={(e) => update({ pickupTime: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="b-return-date">Return Date</Label>
          <input
            id="b-return-date"
            type="date"
            value={state.returnDate}
            min={state.pickupDate}
            onChange={(e) => update({ returnDate: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
        <div>
          <Label htmlFor="b-return-time">Return Time</Label>
          <input
            id="b-return-time"
            type="time"
            value={state.returnTime}
            onChange={(e) => update({ returnTime: e.target.value })}
            className="mt-1.5 h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold"
          />
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <div className="mt-8 flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button size="lg" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}
