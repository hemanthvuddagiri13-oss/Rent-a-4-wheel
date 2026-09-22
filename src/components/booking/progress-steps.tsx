import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { BOOKING_STEPS } from "@/components/booking/types";

export function ProgressSteps({ current }: { current: number }) {
  return (
    <nav aria-label="Booking progress" className="mb-8 min-w-0">
      <p className="mb-3 text-sm text-silver" aria-live="polite">Step {current} of {BOOKING_STEPS.length}: <strong className="text-white">{BOOKING_STEPS[current - 1]}</strong></p>
      <ol className="grid grid-cols-7 gap-2">
        {BOOKING_STEPS.map((label, i) => {
          const stepNum = i + 1;
          const state = stepNum < current ? "done" : stepNum === current ? "current" : "upcoming";
          return (
            <li key={label} aria-current={state === "current" ? "step" : undefined} className="min-w-0">
              <div className="flex flex-col items-center gap-2">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                    state === "done" && "bg-gold text-black",
                    state === "current" && "border-2 border-gold text-gold-bright",
                    state === "upcoming" && "border border-white/15 text-muted"
                  )}
                >
                  {state === "done" ? <><Check aria-hidden="true" className="h-4 w-4" /><span className="sr-only">Completed: </span></> : stepNum}
                </span>
                <span
                  className={cn(
                    "sr-only text-center text-sm font-medium lg:not-sr-only",
                    state === "upcoming" ? "text-muted" : "text-white"
                  )}
                >
                  {label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
