"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
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
import { deleteVehicle, setVehicleStatus } from "@/app/admin/vehicles/actions";

export function DeleteVehicleButton({ vehicleId }: { vehicleId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deleteVehicle(vehicleId);
        toast.success("Vehicle deleted.");
        router.push("/admin/vehicles");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to delete vehicle.");
      }
    });
  }

  function handleDeactivate() {
    startTransition(async () => {
      await setVehicleStatus(vehicleId, "INACTIVE");
      toast.success("Vehicle deactivated.");
      router.refresh();
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <Button type="button" variant="secondary" onClick={handleDeactivate} disabled={isPending}>
        Deactivate
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="destructive">
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this vehicle?</DialogTitle>
            <DialogDescription>
              This permanently removes the vehicle. Vehicles with active or upcoming reservations can&apos;t be
              deleted — deactivate them instead.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-3">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
              Delete Permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
