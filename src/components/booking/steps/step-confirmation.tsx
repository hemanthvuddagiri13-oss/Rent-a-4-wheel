"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Download, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BookingState, BookingVehicle } from "@/components/booking/types";
import { formatCurrency } from "@/lib/utils";

export function StepConfirmation({ vehicle, state }: { vehicle: BookingVehicle; state: BookingState }) {
  const [outcome, setOutcome] = useState("processing");
  const [paidCents, setPaidCents] = useState<number | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = () => fetch(`/api/reservations/${state.reservationId}/status`, { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Status unavailable");
      const data = await response.json(); if (!stopped) { setOutcome(data.outcome); setPaidCents(data.paidCents); }
    }).catch(() => { if (!stopped) setOutcome("status_unavailable"); });
    void poll(); const timer = setInterval(poll, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [state.reservationId]);
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/30">
        <CheckCircle2 className="h-8 w-8 text-emerald-400" />
      </div>
      <h2 className="mt-6 font-display text-3xl font-bold uppercase tracking-tight text-white">{outcome === "confirmed" ? "Confirmed" : outcome.replaceAll("_", " ")}</h2>
      <p className="mt-2 text-muted">Reservation Number</p>
      <p className="mt-1 font-display text-2xl font-semibold text-gold-bright">{state.confirmationNumber}</p>

      <div className="mt-8 w-full max-w-md rounded-xl border border-white/10 bg-card p-6 text-left">
        <Row label="Vehicle" value={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} />
        <Row label="Pickup" value={`${state.pickupDate} at ${state.pickupTime}`} />
        <Row label="Return" value={`${state.returnDate} at ${state.returnTime}`} />
        {paidCents !== null && <Row label="Amount Paid" value={formatCurrency(paidCents)} />}
        {state.breakdown && state.breakdown.depositCents > 0 && (
          <Row label="Security Deposit" value={formatCurrency(state.breakdown.depositCents)} />
        )}
        <Row label="Customer" value={`${state.driver.firstName} ${state.driver.lastName}`} />
      </div>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href={`/account/reservations/${state.reservationId}`}>View Reservation</Link>
        </Button>
        {state.reservationId && (
          <Button asChild variant="outline" size="lg">
            <a href={`/api/reservations/${state.reservationId}/agreement`} target="_blank" rel="noreferrer">
              <Download className="h-4 w-4" /> Download Agreement
            </a>
          </Button>
        )}
        <Button asChild variant="ghost" size="lg">
          <Link href="/contact">
            <MessageCircle className="h-4 w-4" /> Contact Us
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-white/5 py-2 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-white">{value}</span>
    </div>
  );
}
