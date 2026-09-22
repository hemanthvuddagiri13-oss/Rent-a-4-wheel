"use client";
import { useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { formatCurrency } from "@/lib/utils";
import { Panel } from "./workspace";
type Status = { outcome: string; paidCents: number; refundedCents: number; pendingRefundCents: number; depositStatus: string | null; depositValid: boolean; depositRequired: boolean; status: string };
export function PaymentStatus({ id }: { id: string }) {
  const [data, setData] = useState<Status | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    async function poll() { try { const r = await fetch(`/api/reservations/${id}/status`, { cache: "no-store" }); if (!r.ok) throw new Error("Payment status unavailable. Refresh to retry."); const d = await r.json(); if (live) { setData(d); setError(""); } } catch (e) { if (live) setError(e instanceof Error ? e.message : "Payment status is temporarily unavailable."); } }
    void poll(); const timer = setInterval(poll, 5000); return () => { live = false; clearInterval(timer); };
  }, [id]);
  async function retry() {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/reservations/${id}/retry-deposit`, { method: "POST" }), d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (d.requiresAction && d.clientSecret) {
        const client = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ? await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) : null;
        if (!client) throw new Error("Payment provider unavailable.");
        const result = await client.confirmCardPayment(d.clientSecret); if (result.error) throw new Error(result.error.message);
        await fetch(`/api/reservations/${id}/retry-deposit`, { method: "POST" });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Recovery pending."); } finally { setBusy(false); }
  }
  return <Panel title="Payment, refund and deposit"><p role="alert" className="text-sm text-red-300">{error}</p>{data ? <><p className="mb-4 text-gold-bright" role="status">{data.outcome.replaceAll("_", " ")}</p><dl className="grid grid-cols-2 gap-3 text-sm text-silver"><dt>Rental collected</dt><dd>{formatCurrency(data.paidCents)}</dd><dt>Refund completed</dt><dd>{formatCurrency(data.refundedCents)}</dd><dt>Refund pending</dt><dd>{formatCurrency(data.pendingRefundCents)}</dd><dt>Deposit</dt><dd>{data.depositRequired ? (data.depositValid ? "Authorized" : data.depositStatus?.replaceAll("_", " ") || "Authorization required before trip start") : "Not required"}</dd></dl>{["payment_failed", "deposit_action_required"].includes(data.outcome) && <button disabled={busy} onClick={retry} className="mt-5 rounded-lg bg-gold px-5 py-3 font-semibold text-black disabled:opacity-50">{busy ? "Checking deposit…" : "Recover deposit authorization"}</button>}{data.paidCents > 0 && <a className="mt-5 block text-sm text-gold-bright underline" href={`/api/reservations/${id}/receipt`}>Download payment receipt</a>}</> : <p className="text-silver">Loading payment status…</p>}</Panel>;
}
