import type { Metadata } from "next";
import { getSiteSettings } from "@/lib/settings";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { updateSettings } from "@/app/admin/settings/actions";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };
export const revalidate = 0;

export default async function AdminSettingsPage() {
  const settings = await getSiteSettings();

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-white">Business Settings</h1>
      <p className="mt-1 text-sm text-muted">
        Changes here update the live site immediately — no code changes or deploys required.
      </p>

      <form action={updateSettings} className="mt-6 space-y-6">
        <div className="rounded-xl border border-white/10 bg-card p-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="businessName">Business Name</Label>
              <Input id="businessName" name="businessName" defaultValue={settings.businessName} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" defaultValue={settings.phone} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" defaultValue={settings.email} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" defaultValue={settings.address} className="mt-1.5" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="bookingTimezone">Booking time zone (IANA)</Label>
              <Input id="bookingTimezone" name="bookingTimezone" defaultValue={settings.bookingTimezone} />
              <Label htmlFor="operatingHours">Operating Hours</Label>
              <Input id="operatingHours" name="operatingHours" defaultValue={settings.operatingHours} className="mt-1.5" />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Pricing & Policy</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="taxRatePercent">Tax Rate (%)</Label>
              <Input id="taxRatePercent" name="taxRatePercent" type="number" step="0.01" defaultValue={settings.taxRatePercent} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="defaultDeposit">Default Deposit ($)</Label>
              <Input id="defaultDeposit" name="defaultDeposit" type="number" step="0.01" defaultValue={(settings.defaultDepositCents / 100).toFixed(2)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="minimumAge">Minimum Driver Age</Label>
              <Input id="minimumAge" name="minimumAge" type="number" defaultValue={settings.minimumAge} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="checkInWindowHours">Check-In Window (hours before pickup)</Label>
              <Input
                id="checkInWindowHours"
                name="checkInWindowHours"
                type="number"
                min={1}
                defaultValue={settings.checkInWindowHours}
                className="mt-1.5"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="mileagePolicySummary">Mileage Policy Summary</Label>
            <Textarea id="mileagePolicySummary" name="mileagePolicySummary" defaultValue={settings.mileagePolicySummary} className="mt-1.5" rows={2} />
          </div>
          <div>
            <Label htmlFor="cancellationPolicySummary">Cancellation Policy Summary</Label>
            <Textarea
              id="cancellationPolicySummary"
              name="cancellationPolicySummary"
              defaultValue={settings.cancellationPolicySummary}
              className="mt-1.5"
              rows={2}
            />
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Social Links</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="instagram">Instagram URL</Label>
              <Input id="instagram" name="instagram" defaultValue={settings.socialLinks?.instagram ?? ""} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="facebook">Facebook URL</Label>
              <Input id="facebook" name="facebook" defaultValue={settings.socialLinks?.facebook ?? ""} className="mt-1.5" />
            </div>
          </div>
        </div>

        <Button type="submit" size="lg">
          Save Settings
        </Button>
      </form>
    </div>
  );
}
