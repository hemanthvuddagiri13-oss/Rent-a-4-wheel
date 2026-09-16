"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";

export function CancelReservationButton({ reservationId }: { reservationId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleCancel() {
    setLoading(true);
    const res = await fetch(`/api/reservations/${reservationId}/cancel`, { method: "POST" });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      toast.error(data.error || "Unable to cancel reservation.");
      return;
    }
    toast.success("Reservation cancelled.");
    router.refresh();
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">Request Cancellation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this reservation?</DialogTitle>
          <DialogDescription>
            This will cancel your upcoming rental. Refund eligibility is subject to our Cancellation Policy and will
            be reviewed by our team.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-3">
          <DialogClose asChild>
            <Button variant="outline">Keep Reservation</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleCancel} disabled={loading}>
            Yes, Cancel It
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
