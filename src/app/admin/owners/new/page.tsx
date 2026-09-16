import type { Metadata } from "next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { createOwner } from "@/app/admin/owners/actions";

export const metadata: Metadata = { title: "Add Vehicle Owner", robots: { index: false } };

export default function NewOwnerPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-white">Add Vehicle Owner</h1>
      <form action={createOwner} className="mt-6 space-y-6">
        <div className="rounded-xl border border-white/10 bg-card p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Owner Info</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" className="mt-1.5" />
            </div>
          </div>
          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" className="mt-1.5" rows={3} />
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">
            Agreement (optional)
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="agreementStart">Start Date</Label>
              <Input id="agreementStart" name="agreementStart" type="date" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="agreementEnd">End Date</Label>
              <Input id="agreementEnd" name="agreementEnd" type="date" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="paymentArrangement">Payment Arrangement</Label>
              <select
                id="paymentArrangement"
                name="paymentArrangement"
                className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white"
              >
                <option value="MONTHLY_FIXED">Monthly Fixed</option>
                <option value="REVENUE_SHARE">Revenue Share</option>
              </select>
            </div>
            <div>
              <Label htmlFor="monthlyFixed">Monthly Fixed ($)</Label>
              <Input id="monthlyFixed" name="monthlyFixed" type="number" step="0.01" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="revenueShare">Revenue Share (%)</Label>
              <Input id="revenueShare" name="revenueShare" type="number" step="0.01" className="mt-1.5" />
            </div>
          </div>
          <div>
            <Label htmlFor="agreementNotes">Agreement Notes</Label>
            <Textarea id="agreementNotes" name="agreementNotes" className="mt-1.5" rows={2} />
          </div>
        </div>

        <Button type="submit" size="lg">
          Save Owner
        </Button>
      </form>
    </div>
  );
}
