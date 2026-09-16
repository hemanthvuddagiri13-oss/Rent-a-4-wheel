"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateDocumentStatus,
  cancelReservation,
  issueRefund,
  startRental,
  completeRental,
} from "@/app/admin/reservations/actions";

export function DocumentReviewRow({ id, type, status }: { id: string; type: string; status: string }) {
  const [isPending, startTransitionFn] = useTransition();
  const router = useRouter();

  function act(next: "APPROVED" | "REJECTED" | "NEEDS_INFORMATION") {
    startTransitionFn(async () => {
      await updateDocumentStatus(id, next);
      toast.success(`Document marked ${next.toLowerCase().replace("_", " ")}.`);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-surface/60 p-3">
      <div>
        <p className="text-sm font-medium text-white">License — {type}</p>
        <p className="text-xs text-muted">Status: {status.replace(/_/g, " ")}</p>
      </div>
      <div className="flex gap-2">
        <a href={`/api/documents/${id}`} target="_blank" rel="noreferrer" className="text-xs text-gold hover:underline">
          View
        </a>
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => act("APPROVED")}>
          Approve
        </Button>
        <Button size="sm" variant="destructive" disabled={isPending} onClick={() => act("REJECTED")}>
          Reject
        </Button>
      </div>
    </div>
  );
}

export function CancelReservationAdminButton({ reservationId }: { reservationId: string }) {
  const [isPending, startTransitionFn] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant="destructive"
      disabled={isPending}
      onClick={() =>
        startTransitionFn(async () => {
          await cancelReservation(reservationId);
          toast.success("Reservation cancelled.");
          router.refresh();
        })
      }
    >
      Cancel Reservation
    </Button>
  );
}

export function RefundForm({ reservationId, maxCents }: { reservationId: string; maxCents: number }) {
  const [amount, setAmount] = useState((maxCents / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [isPending, startTransitionFn] = useTransition();
  const router = useRouter();

  return (
    <div className="rounded-xl border border-white/10 bg-card p-4">
      <p className="text-sm font-semibold text-white">Issue Refund</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="refund-amount">Amount ($)</Label>
          <Input id="refund-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1.5 w-32" />
        </div>
        <div className="flex-1">
          <Label htmlFor="refund-reason">Reason</Label>
          <Input id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1.5" />
        </div>
        <Button
          disabled={isPending}
          onClick={() =>
            startTransitionFn(async () => {
              try {
                await issueRefund(reservationId, Math.round(Number(amount) * 100), reason || undefined);
                toast.success("Refund issued.");
                router.refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Unable to issue refund.");
              }
            })
          }
        >
          Refund
        </Button>
      </div>
    </div>
  );
}

export function CheckOutForm({ reservationId }: { reservationId: string }) {
  return (
    <form action={startRental} className="rounded-xl border border-white/10 bg-card p-4 space-y-3">
      <p className="text-sm font-semibold text-white">Start Rental (Check-Out)</p>
      <input type="hidden" name="reservationId" value={reservationId} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="co-mileage">Starting Mileage</Label>
          <Input id="co-mileage" name="mileage" type="number" required className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="co-fuel">Fuel Level (%)</Label>
          <Input id="co-fuel" name="fuelLevel" type="number" min={0} max={100} required className="mt-1.5" />
        </div>
      </div>
      <div>
        <Label htmlFor="co-notes">Exterior/Interior Notes</Label>
        <Input id="co-notes" name="notes" className="mt-1.5" />
      </div>
      <Button type="submit">Start Rental</Button>
    </form>
  );
}

export function CheckInForm({ reservationId }: { reservationId: string }) {
  return (
    <form action={completeRental} className="rounded-xl border border-white/10 bg-card p-4 space-y-3">
      <p className="text-sm font-semibold text-white">Complete Rental (Check-In)</p>
      <input type="hidden" name="reservationId" value={reservationId} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="ci-mileage">Ending Mileage</Label>
          <Input id="ci-mileage" name="mileage" type="number" required className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="ci-fuel">Fuel Level (%)</Label>
          <Input id="ci-fuel" name="fuelLevel" type="number" min={0} max={100} required className="mt-1.5" />
        </div>
      </div>
      <div>
        <Label htmlFor="ci-notes">New Damage Notes</Label>
        <Input id="ci-notes" name="notes" className="mt-1.5" />
      </div>
      <div className="flex items-center gap-2">
        <input id="ci-late" name="lateReturn" type="checkbox" className="h-4 w-4 rounded border-white/25 bg-card accent-gold" />
        <Label htmlFor="ci-late">Returned Late</Label>
      </div>
      <div>
        <Label htmlFor="ci-charge">Additional Charge ($)</Label>
        <Input id="ci-charge" name="additionalCharge" type="number" step="0.01" defaultValue="0" className="mt-1.5 w-40" />
      </div>
      <Button type="submit">Complete Rental</Button>
    </form>
  );
}
