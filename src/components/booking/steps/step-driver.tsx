"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmailCodeForm } from "@/components/auth/email-code-form";
import { DocumentUpload } from "@/components/booking/document-upload";
import type { BookingState, BookingVehicle, DriverFormState, UpdateBookingState } from "@/components/booking/types";

interface Props {
  vehicle: BookingVehicle;
  state: BookingState;
  update: UpdateBookingState;
  onNext: () => void;
  onBack: () => void;
}

const US_STATES_HINT = "e.g. TX";

export function StepDriver({ vehicle, state, update, onNext, onBack }: Props) {
  const { data: session, status } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [creatingHold, setCreatingHold] = useState(false);

  useEffect(() => {
    if (!session?.user || state.driver.email) return;
    const [first, ...rest] = (session.user.name || "").split(" ");
    update({
      driver: {
        ...state.driver,
        firstName: state.driver.firstName || first || "",
        lastName: state.driver.lastName || rest.join(" "),
        email: session.user.email || "",
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user]);

  // As soon as the customer is authenticated, place a 15-minute checkout
  // hold on these exact dates so nobody else can book the vehicle out from
  // under them while they finish driver info, documents, and payment.
  useEffect(() => {
    if (!session?.user || state.reservationId) return;
    let cancelled = false;
    async function createHold() {
      setCreatingHold(true);
      setHoldError(null);
      try {
        const res = await fetch("/api/reservations/hold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vehicleId: vehicle.id,
            pickupAt: `${state.pickupDate}T${state.pickupTime}:00`,
            returnAt: `${state.returnDate}T${state.returnTime}:00`,
            extraIds: state.selectedExtraIds,
            couponCode: state.couponCode || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to hold this vehicle for you.");
        if (!cancelled) {
          update({ reservationId: data.id, confirmationNumber: data.confirmationNumber, holdExpiresAt: data.expiresAt });
        }
      } catch (err) {
        if (!cancelled) setHoldError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        if (!cancelled) setCreatingHold(false);
      }
    }
    createHold();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user]);

  function setDriverField<K extends keyof DriverFormState>(key: K, value: DriverFormState[K]) {
    update({ driver: { ...state.driver, [key]: value } });
  }

  function handleContinue() {
    const d = state.driver;
    if (
      !d.firstName ||
      !d.lastName ||
      !d.dob ||
      !d.email ||
      !d.phone ||
      !d.address ||
      !d.city ||
      !d.state ||
      !d.zip ||
      !d.licenseNumber ||
      !d.licenseState ||
      !d.licenseExpiration
    ) {
      setFormError("Please fill in all required driver information fields.");
      return;
    }
    if (!state.documentIds.front || !state.documentIds.back) {
      setFormError("Please upload both the front and back of your driver's license.");
      return;
    }
    if (!state.documentIds.selfie) {
      setFormError("Please upload a selfie holding your physical license.");
      return;
    }
    if (!state.reservationId) {
      setFormError("We're still holding your dates — please wait a moment and try again.");
      return;
    }
    setFormError(null);
    onNext();
  }

  if (status === "loading") {
    return <p className="text-muted">Loading...</p>;
  }

  if (!session) {
    return (
      <div>
        <h2 className="font-display text-2xl font-semibold text-white">Verify Your Information</h2>
        <p className="mt-1 text-sm text-muted">Sign in with a one-time email code to continue your booking.</p>

        <div className="mt-6">
          <EmailCodeForm onSuccess={() => {}} />
        </div>

        <Button variant="outline" className="mt-8" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Driver Information</h2>
      <p className="mt-1 text-sm text-muted">This information will appear on your rental agreement.</p>

      {creatingHold && <p className="mt-2 text-xs text-muted">Holding these dates for you…</p>}
      {holdError && <p className="mt-2 text-xs text-red-400">{holdError}</p>}
      {state.holdExpiresAt && !holdError && (
        <p className="mt-2 text-xs text-gold">
          These dates are held for you until {new Date(state.holdExpiresAt).toLocaleTimeString("en-US")}.
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First Name" value={state.driver.firstName} onChange={(v) => setDriverField("firstName", v)} />
        <Field label="Last Name" value={state.driver.lastName} onChange={(v) => setDriverField("lastName", v)} />
        <Field label="Date of Birth" type="date" value={state.driver.dob} onChange={(v) => setDriverField("dob", v)} />
        <Field label="Email" type="email" value={state.driver.email} onChange={(v) => setDriverField("email", v)} />
        <Field label="Phone" type="tel" value={state.driver.phone} onChange={(v) => setDriverField("phone", v)} />
        <Field label="Address" value={state.driver.address} onChange={(v) => setDriverField("address", v)} />
        <Field label="City" value={state.driver.city} onChange={(v) => setDriverField("city", v)} />
        <Field label="State" hint={US_STATES_HINT} maxLength={2} value={state.driver.state} onChange={(v) => setDriverField("state", v.toUpperCase())} />
        <Field label="ZIP" value={state.driver.zip} onChange={(v) => setDriverField("zip", v)} />
        <Field label="Country" value={state.driver.country} onChange={(v) => setDriverField("country", v)} />
        <Field label="License Number" value={state.driver.licenseNumber} onChange={(v) => setDriverField("licenseNumber", v)} />
        <Field
          label="License State/Country"
          hint={US_STATES_HINT}
          maxLength={2}
          value={state.driver.licenseState}
          onChange={(v) => setDriverField("licenseState", v.toUpperCase())}
        />
        <Field
          label="License Expiration"
          type="date"
          value={state.driver.licenseExpiration}
          onChange={(v) => setDriverField("licenseExpiration", v)}
        />
      </div>

      <h3 className="mt-8 font-display text-lg font-semibold text-white">Driver&apos;s License</h3>
      <p className="mt-1 text-sm text-muted">
        Uploaded securely and only visible to you and authorized Rent A 4Wheel staff.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DocumentUpload
          label="Front of License"
          documentType="LICENSE_FRONT"
          uploaded={Boolean(state.documentIds.front)}
          onUploaded={(id) => update((prev) => ({ documentIds: { ...prev.documentIds, front: id } }))}
        />
        <DocumentUpload
          label="Back of License"
          documentType="LICENSE_BACK"
          uploaded={Boolean(state.documentIds.back)}
          onUploaded={(id) => update((prev) => ({ documentIds: { ...prev.documentIds, back: id } }))}
        />
      </div>

      <h3 className="mt-8 font-display text-lg font-semibold text-white">Selfie Verification</h3>
      <p className="mt-1 text-sm text-muted">
        Take a photo of yourself holding your physical license — this is compared against your uploaded documents
        by the host at pickup.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DocumentUpload
          label="Selfie Holding License"
          documentType="SELFIE_WITH_LICENSE"
          imageOnly
          uploaded={Boolean(state.documentIds.selfie)}
          onUploaded={(id) => update((prev) => ({ documentIds: { ...prev.documentIds, selfie: id } }))}
        />
      </div>

      {formError && <p className="mt-4 text-sm text-red-400">{formError}</p>}

      <div className="mt-8 flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button size="lg" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  maxLength?: number;
}) {
  const id = `driver-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        required
        placeholder={hint}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5"
      />
    </div>
  );
}
