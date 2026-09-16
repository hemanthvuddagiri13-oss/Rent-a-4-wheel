"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { DocumentUpload } from "@/components/booking/document-upload";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { BookingState, DriverFormState, UpdateBookingState } from "@/components/booking/types";

interface Props {
  state: BookingState;
  update: UpdateBookingState;
  onNext: () => void;
  onBack: () => void;
}

const US_STATES_HINT = "e.g. TX";

export function StepDriver({ state, update, onNext, onBack }: Props) {
  const { data: session, status } = useSession();
  const [authTab, setAuthTab] = useState("sign-in");
  const [formError, setFormError] = useState<string | null>(null);

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
        <p className="mt-1 text-sm text-muted">Sign in or create an account to continue your booking.</p>

        <Tabs value={authTab} onValueChange={setAuthTab} className="mt-6">
          <TabsList>
            <TabsTrigger value="sign-in">Sign In</TabsTrigger>
            <TabsTrigger value="sign-up">Create Account</TabsTrigger>
          </TabsList>
          <TabsContent value="sign-in">
            <SignInForm onSuccess={() => {}} />
          </TabsContent>
          <TabsContent value="sign-up">
            <SignUpForm onSuccess={() => {}} />
          </TabsContent>
        </Tabs>

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
          side="FRONT"
          uploaded={Boolean(state.documentIds.front)}
          onUploaded={(id) => update((prev) => ({ documentIds: { ...prev.documentIds, front: id } }))}
        />
        <DocumentUpload
          label="Back of License"
          side="BACK"
          uploaded={Boolean(state.documentIds.back)}
          onUploaded={(id) => update((prev) => ({ documentIds: { ...prev.documentIds, back: id } }))}
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
