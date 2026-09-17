"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

// Identity documents accept images only — never PDF (see
// src/lib/documents.ts for why: an unscanned PDF can carry active
// content, and no PDF-capable malware scanner exists in this deployment).
export function DocumentUpload({
  label,
  documentType,
  onUploaded,
  uploaded,
}: {
  label: string;
  documentType: "LICENSE_FRONT" | "LICENSE_BACK" | "SELFIE_WITH_LICENSE";
  onUploaded: (documentId: string) => void;
  uploaded: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setLoading(true);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("type", documentType);

    try {
      const res = await fetch("/api/documents/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      onUploaded(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
        uploaded ? "border-emerald-500/40 bg-emerald-500/5" : "border-white/15 bg-card hover:border-gold/40"
      )}
    >
      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFile} />
      {loading ? (
        <Loader2 className="h-6 w-6 animate-spin text-gold" />
      ) : uploaded ? (
        <CheckCircle2 className="h-6 w-6 text-emerald-400" />
      ) : (
        <Upload className="h-6 w-6 text-gold" />
      )}
      <span className="text-sm font-medium text-white">{label}</span>
      <span className="text-xs text-muted">{fileName ?? "JPG, PNG, or WEBP — max 8MB"}</span>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </label>
  );
}
