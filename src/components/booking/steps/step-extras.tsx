"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/utils";
import type { BookingExtra } from "@/components/booking/types";

interface Props {
  extras: BookingExtra[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function extraPriceLabel(extra: BookingExtra) {
  if (extra.chargeType === "ONE_TIME") return `${formatCurrency(extra.amountCents ?? 0)} one-time`;
  if (extra.chargeType === "DAILY") return `${formatCurrency(extra.amountCents ?? 0)}/day`;
  return `${extra.percent}% of rental`;
}

export function StepExtras({ extras, selectedIds, onToggle, onNext, onBack }: Props) {
  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Optional Extras</h2>
      <p className="mt-1 text-sm text-muted">Enhance your rental — all extras are optional.</p>

      <div className="mt-6 space-y-3">
        {extras.map((extra) => (
          <label
            key={extra.id}
            className="flex cursor-pointer items-start gap-4 rounded-xl border border-white/10 bg-card p-4 transition-colors hover:border-gold/30"
          >
            <Checkbox checked={selectedIds.includes(extra.id)} onCheckedChange={() => onToggle(extra.id)} className="mt-0.5" />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="font-medium text-white">{extra.name}</p>
                <p className="text-sm font-semibold text-gold-bright">{extraPriceLabel(extra)}</p>
              </div>
              {extra.description && <p className="mt-1 text-sm text-muted">{extra.description}</p>}
            </div>
          </label>
        ))}
        {extras.length === 0 && <p className="text-sm text-muted">No optional extras are currently available.</p>}
      </div>

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
