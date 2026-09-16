"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toggleCoupon } from "@/app/admin/coupons/actions";

export function CouponToggle({ couponId, isActive }: { couponId: string; isActive: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant={isActive ? "destructive" : "outline"}
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await toggleCoupon(couponId, !isActive);
          router.refresh();
        })
      }
    >
      {isActive ? "Deactivate" : "Activate"}
    </Button>
  );
}
