import {AdminMutationFields} from "@/components/admin/admin-mutation-fields";
import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { updateLegalDocument } from "@/app/admin/legal/actions";

export const metadata: Metadata = { title: "Legal Documents", robots: { index: false } };
export const revalidate = 0;

export default async function AdminLegalPage() {
  const docs = await prisma.legalDocument.findMany({ orderBy: { title: "asc" } });

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-white">Legal Documents</h1>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          These documents are placeholders until reviewed by a licensed attorney for the applicable jurisdiction. Do not remove the
          &quot;needs attorney review&quot; flag until legal counsel has approved the final language.
        </p>
      </div>

      <div className="mt-6 space-y-8">
        {docs.map((doc) => (
          <form key={doc.id} action={updateLegalDocument} className="rounded-xl border border-white/10 bg-card p-5 space-y-3">
            <input type="hidden" name="type" value={doc.type} />
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-white">{doc.title}</h2>
              {doc.needsAttorneyReview && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-300">
                  Needs Attorney Review
                </span>
              )}
            </div>
            <div>
              <Label htmlFor={`version-${doc.id}`}>Version</Label>
              <Input id={`version-${doc.id}`} name="version" defaultValue={doc.version} className="mt-1.5 w-40" />
            </div>
            <div>
              <Label htmlFor={`content-${doc.id}`}>Content</Label>
              <Textarea id={`content-${doc.id}`} name="content" defaultValue={doc.content} rows={8} className="mt-1.5 font-mono text-xs" />
            </div>
            <div className="flex items-center gap-2">
              <input
                id={`review-${doc.id}`}
                name="needsAttorneyReview"
                type="checkbox"
                defaultChecked={doc.needsAttorneyReview}
                className="h-4 w-4 rounded border-white/25 bg-card accent-gold"
              />
              <Label htmlFor={`review-${doc.id}`}>Still needs attorney review</Label>
            </div>
            <AdminMutationFields /><Button type="submit">Save {doc.title}</Button>
            <div><Label htmlFor={`attorney-${doc.id}`}>Jurisdiction-specific attorney approval reference (required to enable signing)</Label><Input id={`attorney-${doc.id}`} name="reviewReference" className="mt-2" placeholder="Counsel name and approval record/date" /></div>
          </form>
        ))}
      </div>
    </div>
  );
}
