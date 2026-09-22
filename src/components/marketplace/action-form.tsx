"use client";

import { useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const subscribeHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export type WorkspaceField = {
  name: string; label: string; type?: string; value?: string | number;
  options?: string[]; required?: boolean; min?: number; max?: number; step?: string;
};

export function ActionForm({ endpoint = "/api/host/workspace", action, fields = [], values = {}, label = "Save changes", children, redirectTo, multipart = false }: {
  endpoint?: string; action?: string; fields?: WorkspaceField[]; values?: Record<string, unknown>;
  label?: string; children?: ReactNode; redirectTo?: string; multipart?: boolean;
}) {
  const router = useRouter(), prefix = useId();
  const hydrated = useSyncExternalStore(subscribeHydration, clientReady, serverReady);
  const [pending, setPending] = useState(false), [message, setMessage] = useState(""), [failed, setFailed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage("");
    try {
    const form = new FormData(event.currentTarget);
    const data: Record<string, unknown> = { ...Object.fromEntries(form.entries()), ...values, ...(action ? { action } : {}) };
    for (const field of fields) {
      if (field.type === "money") data[field.name] = Math.round(Number(data[field.name]) * 100);
      if (field.type === "date" || field.type === "datetime-local") {
        const value = String(data[field.name] || "");
        if (value) data[field.name] = new Date(value).toISOString();
      }
      if (field.name === "features") data.features = String(data.features || "").split(",").map(s => s.trim()).filter(Boolean);
    }
    if (multipart) for (const [key, value] of Object.entries(values)) form.set(key, String(value));
      const response = await fetch(endpoint, { method: "POST", ...(multipart ? {} : { headers: { "Content-Type": "application/json" } }), body: multipart ? form : JSON.stringify(data) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to complete this action.");
      setFailed(false); setMessage("Saved successfully."); router.refresh();
      if (redirectTo) router.push(redirectTo.replace(":id", body.id));
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Please try again."); }
    finally { setPending(false); }
  }
  return <form data-hydrated={hydrated ? "true" : "false"} onSubmit={submit} className="space-y-5">
    <fieldset disabled={pending || !hydrated} className="grid min-w-0 gap-4 sm:grid-cols-2">
      {fields.map(field => <div key={field.name} className={`grid min-w-0 gap-2 text-sm text-silver ${field.type === "textarea" ? "sm:col-span-2" : ""}`}>
        <label htmlFor={`${prefix}-${field.name}`}>{field.label}</label>
        {field.options ? <select id={`${prefix}-${field.name}`} name={field.name} defaultValue={field.value} required={field.required !== false} className="workspace-input">{field.options.map(option => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select>
          : field.type === "textarea" ? <textarea id={`${prefix}-${field.name}`} name={field.name} defaultValue={field.value} required={field.required !== false} maxLength={5000} rows={4} className="workspace-input" />
          : <input id={`${prefix}-${field.name}`} name={field.name} type={field.type === "money" ? "number" : field.type || "text"} defaultValue={field.type === "file" ? undefined : field.value} required={field.required !== false} min={field.min} max={field.max} step={field.type === "money" ? "0.01" : field.step} accept={field.type === "file" ? "image/jpeg,image/png,image/webp" : undefined} className="workspace-input" />}
      </div>)}
      {children}
    </fieldset>
    <p role={failed ? "alert" : "status"} className={failed ? "text-sm text-red-300" : "text-sm text-silver"}>{message}</p>
    <button disabled={pending || !hydrated} className="min-h-11 max-w-full whitespace-normal break-words rounded-lg bg-gold px-5 py-3 font-semibold text-black disabled:opacity-50">{pending ? "Saving…" : label}</button>
  </form>;
}
