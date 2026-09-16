"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Values {
  name: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
}

export function ProfileForm({ defaultValues }: { defaultValues: Values }) {
  const [values, setValues] = useState(defaultValues);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch("/api/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setSaving(false);
    if (res.ok) toast.success("Contact information updated.");
    else toast.error("Unable to save changes.");
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <Label htmlFor="acct-name">Full Name</Label>
        <Input id="acct-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="acct-phone">Phone</Label>
        <Input id="acct-phone" value={values.phone} onChange={(e) => setValues({ ...values, phone: e.target.value })} className="mt-1.5" />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="acct-address">Address</Label>
        <Input
          id="acct-address"
          value={values.addressLine1}
          onChange={(e) => setValues({ ...values, addressLine1: e.target.value })}
          className="mt-1.5"
        />
      </div>
      <div>
        <Label htmlFor="acct-city">City</Label>
        <Input id="acct-city" value={values.city} onChange={(e) => setValues({ ...values, city: e.target.value })} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="acct-state">State</Label>
        <Input id="acct-state" maxLength={2} value={values.state} onChange={(e) => setValues({ ...values, state: e.target.value.toUpperCase() })} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="acct-zip">ZIP</Label>
        <Input id="acct-zip" value={values.zip} onChange={(e) => setValues({ ...values, zip: e.target.value })} className="mt-1.5" />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={saving}>
          Save Changes
        </Button>
      </div>
    </form>
  );
}
