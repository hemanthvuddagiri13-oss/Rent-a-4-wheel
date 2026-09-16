import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { BOOKING_STEPS } from "@/components/booking/types";

export function ProgressSteps({ current }: { current: number }) {
  return (
    <div className="mb-8 overflow-x-auto scrollbar-thin">
      <ol className="flex min-w-max items-center gap-1 sm:gap-2">
        {BOOKING_STEPS.map((label, i) => {
          const stepNum = i + 1;
          const state = stepNum < current ? "done" : stepNum === current ? "current" : "upcoming";
          return (
            <li key={label} className="flex items-center gap-1 sm:gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    state === "done" && "bg-gold text-black",
                    state === "current" && "border-2 border-gold text-gold-bright",
                    state === "upcoming" && "border border-white/15 text-muted"
                  )}
                >
                  {state === "done" ? <Check className="h-3.5 w-3.5" /> : stepNum}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium sm:text-sm",
                    state === "upcoming" ? "text-muted" : "text-white"
                  )}
                >
                  {label}
                </span>
              </div>
              {stepNum < BOOKING_STEPS.length && <span className="mx-1 h-px w-4 bg-white/15 sm:w-8" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
