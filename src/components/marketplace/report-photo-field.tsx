"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";

/** Keep the native file in FormData; previews are local and never publicly optimized. */
export function ReportPhotoField({ category, label }: { category: string; label: string }) {
  const id = useId(), input = useRef<HTMLInputElement>(null), url = useRef<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); }, []);
  function clear() {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null; setPreview(null);
  }
  function select(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    clear(); setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      event.target.value = "";
      setError("Choose a JPG, PNG or WEBP image no larger than 8 MB."); return;
    }
    url.current = URL.createObjectURL(file); setPreview(url.current);
  }
  return <div className="min-w-0 space-y-2 text-sm text-silver">
    <label htmlFor={id}>{label}</label>
    <input ref={input} id={id} required type="file" name={category} accept="image/jpeg,image/png,image/webp" capture="environment" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={!!error} onChange={select} className="workspace-input" />
    <p id={`${id}-hint`}>Choose a photo or use your camera. JPG, PNG or WEBP, maximum 8 MB. If camera access is denied, choose an existing image.</p>
    {preview && <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img data-sensitive src={preview} alt={`Local preview: ${label}`} className="max-h-48 w-full rounded-lg bg-surface object-contain" />
      <button type="button" className="min-h-11 rounded-lg border border-white/20 px-4 py-2" onClick={() => { clear(); if (input.current) { input.current.value = ""; input.current.focus(); input.current.click(); } }}>Retake or replace {label.toLowerCase()}</button>
      <p role="status">Photo selected locally. Submit the inspection to save it.</p>
    </>}
    {error && <p id={`${id}-error`} role="alert" className="text-negative">{error}</p>}
  </div>;
}
