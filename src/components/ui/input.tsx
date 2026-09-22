import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex min-h-11 min-w-0 w-full rounded-md border border-silver/40 bg-card px-3.5 py-2 text-base text-white placeholder:text-muted transition-colors aria-invalid:border-red-400",
        "focus-visible:outline-none focus-visible:border-gold focus-visible:ring-1 focus-visible:ring-gold",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
