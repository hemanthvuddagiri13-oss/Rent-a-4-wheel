"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { deleteFaq } from "@/app/admin/faq/actions";

export function DeleteFaqButton({ faqId }: { faqId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(async () => { await deleteFaq(faqId); router.refresh(); })}
      className="text-muted hover:text-red-400"
      aria-label="Delete FAQ"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
