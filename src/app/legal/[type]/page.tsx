import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { LegalDocumentType } from "@prisma/client";

const SLUG_MAP: Record<string, LegalDocumentType> = {
  "rental-agreement": "RENTAL_AGREEMENT",
  "terms-and-conditions": "TERMS_AND_CONDITIONS",
  "privacy-policy": "PRIVACY_POLICY",
  "cancellation-policy": "CANCELLATION_POLICY",
  "insurance-policy": "INSURANCE_POLICY",
  "damage-policy": "DAMAGE_POLICY",
  "security-deposit-policy": "SECURITY_DEPOSIT_POLICY",
};

export async function generateStaticParams() {
  return Object.keys(SLUG_MAP).map((type) => ({ type }));
}

export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const { type } = await params;
  const docType = SLUG_MAP[type];
  if (!docType) return {};
  const doc = await prisma.legalDocument.findUnique({ where: { type: docType } });
  return { title: doc?.title ?? "Legal", alternates: { canonical: `/legal/${type}` }, robots: { index: false } };
}

export const revalidate = 300;

export default async function LegalDocumentPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  const docType = SLUG_MAP[type];
  if (!docType) notFound();

  const doc = await prisma.legalDocument.findUnique({ where: { type: docType } });
  if (!doc) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="font-display text-3xl font-bold text-white">{doc.title}</h1>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">Version {doc.version}</p>

      {doc.needsAttorneyReview && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            This document is a placeholder pending qualified legal review for the applicable jurisdiction. It does not yet reflect
            final, binding legal terms.
          </p>
        </div>
      )}

      <div className="mt-8 whitespace-pre-wrap text-sm leading-relaxed text-silver">{doc.content}</div>
    </div>
  );
}
