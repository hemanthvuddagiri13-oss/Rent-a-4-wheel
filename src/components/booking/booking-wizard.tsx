"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ProgressSteps } from "@/components/booking/progress-steps";
import { StepVehicle } from "@/components/booking/steps/step-vehicle";
import { StepDates } from "@/components/booking/steps/step-dates";
import { StepExtras } from "@/components/booking/steps/step-extras";
import { StepDriver } from "@/components/booking/steps/step-driver";
import { StepReview } from "@/components/booking/steps/step-review";
import { StepPayment } from "@/components/booking/steps/step-payment";
import { StepConfirmation } from "@/components/booking/steps/step-confirmation";
import { emptyDriverForm, type BookingExtra, type BookingState, type BookingVehicle } from "@/components/booking/types";

function defaultDate(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

export function BookingWizard({ vehicle, extras }: { vehicle: BookingVehicle; extras: BookingExtra[] }) {
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [dateError, setDateError] = useState<string | null>(null);

  const [state, setState] = useState<BookingState>({
    pickupDate: searchParams.get("pickupDate") || defaultDate(1),
    pickupTime: searchParams.get("pickupTime") || "10:00",
    returnDate: searchParams.get("returnDate") || defaultDate(4),
    returnTime: searchParams.get("returnTime") || "10:00",
    selectedExtraIds: [],
    couponCode: "",
    driver: emptyDriverForm,
    documentIds: {},
    agreementAccepted: false,
    breakdown: null,
    reservationId: null,
    confirmationNumber: null,
    holdExpiresAt: null,
  });

  function update(patch: Partial<BookingState> | ((prev: BookingState) => Partial<BookingState>)) {
    setState((prev) => ({ ...prev, ...(typeof patch === "function" ? patch(prev) : patch) }));
  }

  function toggleExtra(id: string) {
    setState((prev) => ({
      ...prev,
      selectedExtraIds: prev.selectedExtraIds.includes(id)
        ? prev.selectedExtraIds.filter((e) => e !== id)
        : [...prev.selectedExtraIds, id],
    }));
  }

  function goNext() {
    if (step === 2) {
      const pickup = new Date(`${state.pickupDate}T${state.pickupTime}:00`);
      const ret = new Date(`${state.returnDate}T${state.returnTime}:00`);
      if (ret <= pickup) {
        setDateError("Return date/time must be after pickup date/time.");
        return;
      }
      setDateError(null);
    }
    setStep((s) => Math.min(s + 1, 7));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <ProgressSteps current={step} />

      <div className="rounded-2xl border border-white/10 bg-background p-6 sm:p-8">
        {step === 1 && <StepVehicle vehicle={vehicle} onNext={goNext} />}
        {step === 2 && <StepDates state={state} update={update} onNext={goNext} onBack={goBack} error={dateError} />}
        {step === 3 && (
          <StepExtras
            extras={extras}
            selectedIds={state.selectedExtraIds}
            onToggle={toggleExtra}
            onNext={goNext}
            onBack={goBack}
          />
        )}
        {step === 4 && (
          <StepDriver vehicle={vehicle} state={state} update={update} onNext={goNext} onBack={goBack} />
        )}
        {step === 5 && (
          <StepReview vehicle={vehicle} extras={extras} state={state} update={update} onNext={goNext} onBack={goBack} />
        )}
        {step === 6 && <StepPayment state={state} onSuccess={goNext} onBack={goBack} />}
        {step === 7 && <StepConfirmation vehicle={vehicle} state={state} />}
      </div>
    </div>
  );
}
