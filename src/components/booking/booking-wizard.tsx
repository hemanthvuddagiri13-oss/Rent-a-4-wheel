"use client";

import { useEffect, useState } from "react";
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
    draftId: crypto.randomUUID(), revision: 1,
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

  const [resumeId] = useState(() => searchParams.get("reservationId"));
  const [resuming, setResuming] = useState(Boolean(resumeId));
  const [resumeError, setResumeError] = useState<string | null>(null);
  useEffect(() => {
    if (!resumeId) return;
    let stopped = false;
    fetch('/api/reservations/' + encodeURIComponent(resumeId) + '/resume').then(async response => {
      if (!response.ok) throw new Error("Unable to resume reservation");
      const r = await response.json();
      if (r.vehicleId !== vehicle.id) throw new Error("Reservation vehicle mismatch");
      if (stopped) return;
      const dateParts = (value: string) => { const d = new Date(value); return [new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10), d.toTimeString().slice(0, 5)]; };
      const [pickupDate, pickupTime] = dateParts(r.pickupAt), [returnDate, returnTime] = dateParts(r.returnAt);
      setState(prev => ({ ...prev, reservationId: r.reservationId, confirmationNumber: r.confirmationNumber, pickupDate, pickupTime, returnDate, returnTime,
        selectedExtraIds: r.selectedExtraIds, couponCode: r.couponCode, breakdown: r.breakdown, bookingFingerprint: r.bookingFingerprint,
        checkoutComplete: r.checkoutComplete, agreementAccepted: r.checkoutComplete, holdExpiresAt: r.holdExpiresAt,
        draftId: r.draftId ?? prev.draftId, revision: r.revision ?? prev.revision }));
      setStep(r.checkoutComplete || r.status !== "CHECKOUT_HOLD" ? 6 : 4);
      setResuming(false);
      const url = new URL(window.location.href);
      for (const key of ["payment_intent", "payment_intent_client_secret", "redirect_status"]) url.searchParams.delete(key);
      window.history.replaceState(null, "", url);
    }).catch(() => { if (!stopped) setResumeError("Unable to resume this reservation. Please sign in as its owner."); });
    return () => { stopped = true; };
  }, [resumeId, vehicle.id]);
  useEffect(() => {
    if (!state.reservationId || resumeId === state.reservationId) return;
    const url = new URL(window.location.href); url.searchParams.set("reservationId", state.reservationId);
    window.history.replaceState(null, "", url);
  }, [state.reservationId, resumeId]);

  function update(patch: Partial<BookingState> | ((prev: BookingState) => Partial<BookingState>)) {
    setState((prev) => {
      const value = typeof patch === "function" ? patch(prev) : patch;
      const changed = ["pickupDate", "pickupTime", "returnDate", "returnTime", "selectedExtraIds", "couponCode"].some(k => k in value);
      if (prev.checkoutComplete && changed) return prev;
      return { ...prev, ...value, revision: changed ? prev.revision + 1 : prev.revision };
    });
  }

  function toggleExtra(id: string) {
    setState((prev) => ({
      ...prev,
      revision: prev.revision + 1,
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

  if (resuming) return <p role="status">{resumeError ?? "Resuming reservation…"}</p>;
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
        {step === 6 && <StepPayment state={state} onCheckoutComplete={() => update({ checkoutComplete: true })} onSuccess={goNext} onBack={goBack} />}
        {step === 7 && <StepConfirmation vehicle={vehicle} state={state} />}
      </div>
    </div>
  );
}
