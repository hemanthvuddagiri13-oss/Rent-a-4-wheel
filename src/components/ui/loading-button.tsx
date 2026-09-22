"use client";

import { LoaderCircle } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

/** Pending is supplied by the real request owner; this control never infers success. */
export function LoadingButton({ pending, pendingLabel = "Working…", children, disabled, ...props }: Omit<ButtonProps, "asChild"> & { pending: boolean; pendingLabel?: string }) {
  return <Button {...props} disabled={disabled || pending} aria-busy={pending}>
    {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
    <span>{pending ? pendingLabel : children}</span>
  </Button>;
}
