import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-24 min-w-0 w-full rounded-md border border-silver/40 bg-card px-3.5 py-2.5 text-base text-white placeholder:text-muted aria-invalid:border-red-400",
        "focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
