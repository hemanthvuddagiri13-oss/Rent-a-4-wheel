import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface Owner {
  id: string;
  name: string;
}

interface VehicleDefaults {
  vin?: string;
  licensePlate?: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string | null;
  color?: string | null;
  mileage?: number;
  category?: string;
  transmission?: string;
  fuelType?: string;
  seats?: number;
  doors?: number;
  mpg?: number | null;
  description?: string | null;
  status?: string;
  dailyRateCents?: number;
  weeklyRateCents?: number;
  monthlyRateCents?: number;
  securityDepositCents?: number;
  mileageAllowancePerDay?: number;
  additionalMileageFeeCents?: number;
  ownershipType?: string;
  ownerId?: string | null;
  registrationExpiresAt?: Date | null;
  insuranceExpiresAt?: Date | null;
  inspectionExpiresAt?: Date | null;
  imageUrls?: string[];
}

function dateInput(d?: Date | null) {
  return d ? d.toISOString().slice(0, 10) : "";
}

export function VehicleForm({
  action,
  defaults = {},
  owners,
  submitLabel = "Save Vehicle",
}: {
  action: (formData: FormData) => void;
  defaults?: VehicleDefaults;
  owners: Owner[];
  submitLabel?: string;
}) {
  return (
    <form action={action} className="space-y-8">
      <Section title="Vehicle Identity">
        <Field label="VIN" name="vin" defaultValue={defaults.vin} required />
        <Field label="License Plate" name="licensePlate" defaultValue={defaults.licensePlate} required />
        <Field label="Year" name="year" type="number" defaultValue={defaults.year} required />
        <Field label="Make" name="make" defaultValue={defaults.make} required />
        <Field label="Model" name="model" defaultValue={defaults.model} required />
        <Field label="Trim" name="trim" defaultValue={defaults.trim ?? ""} />
        <Field label="Color" name="color" defaultValue={defaults.color ?? ""} />
        <Field label="Mileage" name="mileage" type="number" defaultValue={defaults.mileage} />
      </Section>

      <Section title="Classification">
        <SelectField
          label="Category"
          name="category"
          defaultValue={defaults.category ?? "SEDAN"}
          options={["ECONOMY", "SEDAN", "SUV", "LUXURY", "TRUCK"]}
        />
        <SelectField
          label="Transmission"
          name="transmission"
          defaultValue={defaults.transmission ?? "AUTOMATIC"}
          options={["AUTOMATIC", "MANUAL"]}
        />
        <SelectField
          label="Fuel Type"
          name="fuelType"
          defaultValue={defaults.fuelType ?? "GASOLINE"}
          options={["GASOLINE", "DIESEL", "HYBRID", "ELECTRIC"]}
        />
        <Field label="Seats" name="seats" type="number" defaultValue={defaults.seats ?? 5} />
        <Field label="Doors" name="doors" type="number" defaultValue={defaults.doors ?? 4} />
        <Field label="MPG" name="mpg" type="number" defaultValue={defaults.mpg ?? ""} />
        <SelectField label="Status" name="status" defaultValue={defaults.status ?? "ACTIVE"} options={["ACTIVE", "MAINTENANCE", "INACTIVE", "RETIRED"]} />
      </Section>

      <Section title="Description">
        <div className="sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" defaultValue={defaults.description ?? ""} className="mt-1.5" rows={3} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="imageUrls">Image URLs (one per line — first is primary)</Label>
          <Textarea
            id="imageUrls"
            name="imageUrls"
            defaultValue={(defaults.imageUrls ?? []).join("\n")}
            placeholder="/images/vehicles/sedan.svg"
            className="mt-1.5"
            rows={3}
          />
        </div>
      </Section>

      <Section title="Pricing">
        <Field label="Daily Rate ($)" name="dailyRate" type="number" step="0.01" defaultValue={centsToDollars(defaults.dailyRateCents)} required />
        <Field label="Weekly Rate ($)" name="weeklyRate" type="number" step="0.01" defaultValue={centsToDollars(defaults.weeklyRateCents)} required />
        <Field label="Monthly Rate ($)" name="monthlyRate" type="number" step="0.01" defaultValue={centsToDollars(defaults.monthlyRateCents)} required />
        <Field label="Security Deposit ($)" name="securityDeposit" type="number" step="0.01" defaultValue={centsToDollars(defaults.securityDepositCents)} />
        <Field label="Mileage Allowance / Day" name="mileageAllowancePerDay" type="number" defaultValue={defaults.mileageAllowancePerDay ?? 150} />
        <Field
          label="Additional Mileage Fee ($/mi)"
          name="additionalMileageFee"
          type="number"
          step="0.01"
          defaultValue={centsToDollars(defaults.additionalMileageFeeCents)}
        />
      </Section>

      <Section title="Ownership & Compliance">
        <SelectField
          label="Ownership Type"
          name="ownershipType"
          defaultValue={defaults.ownershipType ?? "COMPANY_OWNED"}
          options={["COMPANY_OWNED", "LEASED_TO_COMPANY", "MANAGED_VEHICLE"]}
        />
        <div>
          <Label htmlFor="ownerId">Vehicle Owner</Label>
          <select
            id="ownerId"
            name="ownerId"
            defaultValue={defaults.ownerId ?? ""}
            className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white"
          >
            <option value="">Company (no external owner)</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="Registration Expires" name="registrationExpiresAt" type="date" defaultValue={dateInput(defaults.registrationExpiresAt)} />
        <Field label="Insurance Expires" name="insuranceExpiresAt" type="date" defaultValue={dateInput(defaults.insuranceExpiresAt)} />
        <Field label="Inspection Expires" name="inspectionExpiresAt" type="date" defaultValue={dateInput(defaults.inspectionExpiresAt)} />
      </Section>

      <Button type="submit" size="lg">
        {submitLabel}
      </Button>
    </form>
  );
}

function centsToDollars(cents?: number) {
  return cents != null ? (cents / 100).toFixed(2) : "";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-5">
      <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">{title}</h3>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  step?: string;
}) {
  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} step={step} required={required} defaultValue={defaultValue ?? undefined} className="mt-1.5" />
    </div>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </div>
  );
}
