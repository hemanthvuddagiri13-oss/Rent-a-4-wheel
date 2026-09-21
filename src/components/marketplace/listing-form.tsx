import type { Vehicle } from "@prisma/client";
import { JURISDICTION_CODES } from "@/lib/jurisdiction-codes";
import { ActionForm, type WorkspaceField } from "./action-form";
export function ListingForm({ vehicle, features = "", owners }: { vehicle?: Vehicle; features?: string; owners: { id: string; name: string }[] }) {
  const fields: WorkspaceField[] = [
    { name: "vin", label: "VIN (17 characters)", value: vehicle?.vin }, { name: "licensePlate", label: "License plate", value: vehicle?.licensePlate },
    { name: "year", label: "Year", type: "number", value: vehicle?.year ?? new Date().getFullYear(), min: 1980 },
    { name: "make", label: "Make", value: vehicle?.make }, { name: "model", label: "Model", value: vehicle?.model },
    { name: "category", label: "Category", options: ["ECONOMY", "SEDAN", "SUV", "LUXURY", "TRUCK"], value: vehicle?.category },
    { name: "transmission", label: "Transmission", options: ["AUTOMATIC", "MANUAL"], value: vehicle?.transmission },
    { name: "fuelType", label: "Fuel or power", options: ["GASOLINE", "DIESEL", "HYBRID", "ELECTRIC"], value: vehicle?.fuelType },
    { name: "seats", label: "Seats", type: "number", value: vehicle?.seats ?? 5, min: 1, max: 15 },
    { name: "mileage", label: "Current odometer (miles)", type: "number", value: vehicle?.mileage ?? 0, min: 0 },
    ...(["dailyRateCents", "weeklyRateCents", "monthlyRateCents", "securityDepositCents", "additionalMileageFeeCents"] as const).map((name, i) => ({ name, label: ["Daily price ($)", "Weekly price ($)", "Monthly price ($)", "Security deposit ($)", "Extra mileage ($/mile)"][i], type: "money", min: 0, value: (vehicle?.[name] ?? [5000, 30000, 100000, 30000, 35][i]) / 100 })),
    { name: "mileageAllowancePerDay", label: "Included miles per day", type: "number", min: 1, value: vehicle?.mileageAllowancePerDay ?? 150 },
    { name: "location", label: "Pickup city", value: vehicle?.location ?? "" },
    { name: "jurisdictionCode", label: "Vehicle operating state", options: [...JURISDICTION_CODES], value: vehicle?.jurisdictionCode ?? "" },
    { name: "registrationExpiresAt", label: "Registration expiration", type: "date", value: vehicle?.registrationExpiresAt?.toISOString().slice(0, 10) },
    { name: "insuranceExpiresAt", label: "Insurance expiration", type: "date", value: vehicle?.insuranceExpiresAt?.toISOString().slice(0, 10) },
    { name: "ownershipType", label: "Ownership arrangement", options: ["COMPANY_OWNED", "LEASED_TO_COMPANY", "MANAGED_VEHICLE"], value: vehicle?.ownershipType },
    { name: "features", label: "Features (comma separated)", value: features, required: false },
    { name: "description", label: "Describe your vehicle", type: "textarea", value: vehicle?.description ?? "" },
    { name: "rules", label: "Vehicle rules", type: "textarea", value: vehicle?.rules ?? "", required: false },
  ];
  return <ActionForm action="listing" values={vehicle ? { id: vehicle.id } : {}} fields={fields} label="Save listing for review" redirectTo="/host/vehicles/:id"><label className="grid gap-2 text-sm text-silver">Vehicle owner<select name="ownerId" defaultValue={vehicle?.ownerId ?? ""} className="workspace-input"><option value="">Business-owned</option>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label></ActionForm>;
}
