"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { togglePublished } from "@/app/admin/reviews/actions";

export function ReviewToggle({ reviewId, isPublished }: { reviewId: string; isPublished: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant={isPublished ? "secondary" : "outline"}
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await togglePublished(reviewId, !isPublished);
          router.refresh();
        })
      }
    >
      {isPublished ? "Unpublish" : "Publish"}
    </Button>
  );
}
