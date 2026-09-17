"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Panel } from "./workspace";
import type { tripExperience } from "@/lib/trip-experience";
type Experience = Awaited<ReturnType<typeof tripExperience>>;
export function TripConsole({ reservationId }: { reservationId: string }) {
  const [data, setData] = useState<Experience | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const base = `/api/reservations/${reservationId}`;
  async function refresh() {
    const response = await fetch(`${base}/experience`, { cache: "no-store" });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); setData(body);
  }
  useEffect(() => {
    let active = true;
    async function poll() { try { const r = await fetch(`${base}/experience`, { cache: "no-store" }); const d = await r.json(); if (active) { if (r.ok) setData(d); else setError(d.error); } } catch { if (active) setError("Unable to load trip updates. Please refresh."); } }
    void poll(); const timer = setInterval(poll, 15000); return () => { active = false; clearInterval(timer); };
  }, [base]);
  async function send(path: string, body: unknown) {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await r.json(); if (!r.ok) throw new Error([result.error, ...(result.reasons || [])].join(" "));
      await refresh(); setNotice("Saved. Your trip checklist is up to date.");
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  }
  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const form = new FormData(event.currentTarget);
    for (const category of ["EXTERIOR", "INTERIOR"]) {
      const file = form.get(category);
      if (file instanceof File) { form.append("photo", file); form.append("category", category); }
      form.delete(category);
    }
    try {
      const r = await fetch(`${base}/condition-reports`, { method: "POST", body: form }), body = await r.json();
      if (!r.ok) throw new Error(body.error); await refresh(); setNotice("Report submitted. Review it below and accept it as accurate.");
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  }
  const button = "min-h-11 rounded-lg bg-gold px-5 py-3 font-semibold text-black disabled:opacity-40";
  if (!data) return <Panel title="Trip workspace"><p role="status" className="text-silver">{error || "Loading your trip…"}</p></Panel>;
  const pretrip = ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"].includes(data.status);
  const returning = data.status === "RETURN_IN_PROGRESS", phase = returning ? "POST_TRIP" : "PRE_TRIP";
  const ownReport = data.reports.find(r => r.role === data.role && r.phase === phase);
  const returnReport = data.reports.find(r => r.role === "HOST" && r.phase === "POST_TRIP");
  const lateMinutes = Math.max(0, Math.round((new Date(data.trip?.endedAt ?? data.observedAt).getTime() - new Date(data.returnAt).getTime()) / 60000));
  return <div className="space-y-6">
    <p role="alert" className="text-red-300">{error}</p><p role="status" className="text-gold-bright">{notice}</p>
    <Panel title={data.status === "ACTIVE" ? "Your trip is underway" : returning ? "Return your vehicle" : "Pickup and trip readiness"}>
      <p className="mb-4 text-sm text-silver">{data.status.replaceAll("_", " ")} · {data.pickupLocation}</p>
      {pretrip && <><ul className="mb-5 space-y-2 text-sm text-silver">{data.gate.reasons.map(reason => <li key={reason}>○ {reason}</li>)}{data.gate.canStart && <li>✓ All trip-start requirements are met.</li>}</ul><div className="flex flex-wrap gap-3">{data.role === "HOST" ? <button disabled={busy || data.keysReleased} onClick={() => send("/experience", { action: "keys" })} className={button}>{data.keysReleased ? "Keys released" : "Confirm keys handed over"}</button> : <button disabled={busy || !data.gate.canStart} onClick={() => send("/start-trip", {})} className={button}>Start trip</button>}</div></>}
      {data.status === "ACTIVE" && <><p className="mb-5 text-silver">Return by {new Date(data.returnAt).toLocaleString(undefined, { timeZone: data.bookingTimezone })} ({data.bookingTimezone}). Contact support if your plans change.</p><button className={button} disabled={busy} onClick={() => send("/experience", { action: "return" })}>Begin return inspection</button></>}
      {returning && data.role === "HOST" && <button className={button} disabled={busy} onClick={() => send("/experience", { action: "complete" })}>Complete return review</button>}
      {data.status === "COMPLETED" && <p className="text-silver">Return complete. Any required deposit release is processed through the financial recovery worker; check payment status for the latest result.</p>}
      {data.status === "DISPUTED" && <p className="text-silver">Return evidence has been sent for damage review. No additional charge is automatically applied.</p>}
    </Panel>
    <Panel title="Identity documents"><div className="space-y-3">{data.documents.length ? data.documents.map(d => <p key={d.id} className="text-sm text-silver">{d.type.replaceAll("_", " ")} · {d.status.replaceAll("_", " ")} · {d.malwareScanStatus} {(data.role === "CUSTOMER" || d.malwareScanStatus === "CLEAN") && <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="ml-2 text-gold-bright underline">View private document</a>}</p>) : <p className="text-silver">No identity documents attached.</p>}</div></Panel>
    {pretrip && data.role === "HOST" && <Panel title="In-person identity handoff"><p className="mb-4 text-silver">Compare the physical, unexpired license with the clean uploaded documents and the person collecting the vehicle.</p><form onSubmit={event => { event.preventDefault(); const f = new FormData(event.currentTarget); void send("/identity-handoff", { licenseMatchesUpload: f.has("license"), physicalLicenseUnexpired: f.has("expiry"), selfieMatchesCustomer: f.has("selfie"), notes: String(f.get("notes") || "") }); }} className="space-y-4">{[["license", "Physical license matches uploaded license"], ["expiry", "Physical license is unexpired"], ["selfie", "Person matches the uploaded selfie"]].map(([name, label]) => <label key={name} className="flex items-center gap-3 text-silver"><input type="checkbox" name={name} required className="h-5 w-5" />{label}</label>)}<label className="grid gap-2 text-sm text-silver">Handoff notes<textarea name="notes" maxLength={2000} className="workspace-input" /></label><button disabled={busy} className={button}>Confirm identity handoff</button></form>{data.handoffVerified && <p className="mt-4 text-gold-bright">Identity handoff recorded.</p>}</Panel>}
    {(pretrip || returning) && !ownReport && <Panel title={returning ? "Your return inspection" : "Your pre-trip inspection"}><form onSubmit={report} className="space-y-5"><input type="hidden" name="phase" value={phase} /><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm text-silver">Odometer (miles)<input required type="number" name="mileage" min={data.trip?.startMileage ?? 0} className="workspace-input" /></label><label className="grid gap-2 text-sm text-silver">Fuel / battery (%)<input required type="number" name="fuelLevel" min={0} max={100} className="workspace-input" /></label>{["EXTERIOR", "INTERIOR"].map(category => <label key={category} className="grid gap-2 text-sm text-silver">{category === "EXTERIOR" ? "Exterior photo" : "Interior photo"}<input required type="file" name={category} accept="image/jpeg,image/png,image/webp" className="workspace-input" /><span className="text-xs">Choose a photo or use your device camera. Maximum 8 MB.</span></label>)}</div><label className="grid gap-2 text-sm text-silver">Damage or condition notes<textarea name="damageNotes" maxLength={2000} className="workspace-input" /><span className="text-xs">Leave blank if there is no damage to report.</span></label><button className={button} disabled={busy}>Submit inspection report</button></form></Panel>}
    <Panel title="Inspection evidence">{data.reports.length ? data.reports.map(r => <div key={r.id} className="mb-5 rounded-xl border border-white/10 p-4"><h3 className="text-white">{r.role} · {r.phase.replaceAll("_", " ")}</h3><p className="mt-2 text-sm text-silver">{r.mileage.toLocaleString()} miles · {r.fuelLevel}% fuel / charge</p>{r.damageNotes && <p className="mt-2 text-sm text-silver">{r.damageNotes}</p>}<div className="my-4 flex flex-wrap gap-4">{r.photos.map(p => <a className="text-sm text-gold-bright underline" href={`${base}/photos/${p.id}`} key={p.id}>{p.category} photo</a>)}</div>{r.acceptedAt ? <p className="text-sm text-gold-bright">Accepted by author</p> : r.own && <button disabled={busy} className={button} onClick={() => send(`/condition-reports/${r.id}/accept`, {})}>I accept this report as accurate</button>}</div>) : <p className="text-silver">Inspection reports will appear here after submission.</p>}</Panel>
    {returnReport && data.trip && <Panel title="Return comparison"><dl className="grid grid-cols-2 gap-3 text-sm text-silver"><dt>Miles driven</dt><dd>{returnReport.mileage - (data.trip.startMileage ?? returnReport.mileage)} miles</dd><dt>Fuel / charge at pickup</dt><dd>{data.trip.startFuelLevel ?? "Not recorded"}%</dd><dt>Fuel / charge at return</dt><dd>{returnReport.fuelLevel}%</dd><dt>Return timing</dt><dd>{lateMinutes ? `${lateMinutes} minutes after scheduled return` : "Within scheduled return time"}</dd></dl><p className="mt-4 text-xs text-muted">Inspection evidence is reviewed before any separate damage or additional-charge decision. This comparison does not charge your card.</p></Panel>}
    <Panel title="Trip activity"><ol className="space-y-3 text-sm text-silver">{data.events.map(e => <li key={e.id}>{e.type.replaceAll("_", " ")} · {new Date(e.createdAt).toLocaleString()}</li>)}</ol></Panel>
  </div>;
}
