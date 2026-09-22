"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Camera, ImagePlus, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";

export function DocumentUpload({ label, documentType, onUploaded, uploaded }: {
  label: string;
  documentType: "LICENSE_FRONT" | "LICENSE_BACK" | "SELFIE_WITH_LICENSE";
  onUploaded: (documentId: string) => void;
  uploaded: boolean;
}) {
  const id = useId(), camera = useRef<HTMLInputElement>(null), picker = useRef<HTMLInputElement>(null);
  const localUrl = useRef<string | null>(null), request = useRef<XMLHttpRequest | null>(null);
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null), [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => () => { request.current?.abort(); if (localUrl.current) URL.revokeObjectURL(localUrl.current); }, []);

  function select(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0]; event.target.value = "";
    if (!next || loading) return;
    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(next.type) || next.size > 8 * 1024 * 1024) {
      setError("Choose a JPG, PNG or WEBP image no larger than 8 MB."); return;
    }
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = URL.createObjectURL(next); setPreview(localUrl.current); setFile(next); setReceipt(null);
  }
  function upload() {
    if (!file || request.current) return;
    setLoading(true); setProgress(0); setError(null);
    const data = new FormData(); data.append("file", file); data.append("type", documentType);
    const xhr = new XMLHttpRequest(); request.current = xhr;
    xhr.open("POST", "/api/documents/upload"); xhr.timeout = 120000;
    xhr.upload.onprogress = event => setProgress(event.lengthComputable ? Math.round(event.loaded * 100 / event.total) : null);
    const finish = () => { request.current = null; setLoading(false); };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300 || typeof result.id !== "string") throw new Error(result.error || "The upload could not be saved. Please try again.");
        onUploaded(result.id);
        setReceipt(result.malwareScanStatus === "QUARANTINED" ? "Saved in quarantine. A security scan is required before review or use." : "Upload saved. Identity review is still required.");
        setFile(null); setPreview(null);
        if (localUrl.current) { URL.revokeObjectURL(localUrl.current); localUrl.current = null; }
      } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to read the upload response. Check your documents before retrying."); }
      finally { finish(); }
    };
    xhr.onerror = xhr.ontimeout = () => { setError("The connection was interrupted. The save could not be confirmed. Check your reservation documents before trying again."); finish(); };
    xhr.send(data);
  }
  return <section data-document-upload={documentType} aria-labelledby={id + "-title"} className="min-w-0 rounded-xl border border-white/15 bg-card p-5">
    <h3 id={id + "-title"} className="font-semibold text-white">{label}</h3>
    <p id={id + "-guide"} className="mt-2 text-sm text-silver">{documentType === "SELFIE_WITH_LICENSE" ? "Hold the license beside your face. Keep your face and all license details visible." : "Include all four corners of the license. Use good lighting and avoid glare."}</p>
    <p className="mt-2 text-sm text-muted">JPG, PNG or WEBP · maximum 8 MB. Review your image before uploading.</p>
    <input ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture={documentType === "SELFIE_WITH_LICENSE" ? "user" : "environment"} hidden onChange={select} />
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={select} />
    <div className="mt-4 flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={loading} aria-describedby={id + "-guide"} onClick={() => camera.current?.click()}><Camera aria-hidden="true" className="h-4 w-4" />{preview ? "Retake photo" : "Take photo"}</Button>
      <Button type="button" variant="outline" disabled={loading} onClick={() => picker.current?.click()}><ImagePlus aria-hidden="true" className="h-4 w-4" />Choose image</Button>
    </div>
    <p className="mt-2 text-sm text-muted">If the camera is unavailable or permission is denied, choose an existing image instead.</p>
    {preview && <div className="mt-4 space-y-3">
      {/* A private local blob preview must never pass through public image optimization. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img data-sensitive src={preview} alt={`Local preview of ${label}`} className="max-h-64 w-full rounded-lg bg-surface object-contain" />
      <LoadingButton type="button" pending={loading} pendingLabel="Uploading…" onClick={upload}>Upload this image</LoadingButton>
    </div>}
    {loading && <div className="mt-3"><progress aria-label={`${label} upload`} value={progress ?? undefined} max={100} className="w-full accent-gold" /><p role="status" className="text-sm text-silver">{progress === 100 ? "Checking and saving your image…" : "Uploading your image…"}</p></div>}
    {error && <p role="alert" className="mt-3 text-sm text-negative">{error}</p>}
    <p role="status" className="mt-3 text-sm text-silver">{receipt ?? (uploaded ? "An upload is attached. Uploading alone does not approve your identity." : "No upload saved from this step yet.")}</p>
    <p className="mt-3 flex gap-2 text-sm text-muted"><Shield aria-hidden="true" className="h-4 w-4 shrink-0" />Images remain private. Security scanning and identity review are separate checks.</p>
  </section>;
}
