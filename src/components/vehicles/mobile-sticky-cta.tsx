"use client";

import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function MobileStickyCta({ dailyRateCents }: { dailyRateCents: number }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-4 border-t border-white/10 bg-[#0a0a0acc] p-4 backdrop-blur-lg lg:hidden">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted">From</p>
        <p className="font-display text-lg font-bold text-gold-bright">{formatCurrency(dailyRateCents)}/day</p>
      </div>
      <Button size="lg" asChild className="flex-1 max-w-[220px]">
        <a href="#book">Book Now</a>
      </Button>
    </div>
  );
}
