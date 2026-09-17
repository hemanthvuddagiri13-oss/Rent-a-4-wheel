import Link from "next/link";
import type { ReactNode } from "react";

export function Workspace({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children: ReactNode }) {
  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <p className="text-xs font-semibold uppercase tracking-[.22em] text-gold-bright">{eyebrow}</p>
    <h1 className="mt-3 font-display text-3xl font-semibold text-white sm:text-4xl">{title}</h1>
    {description && <p className="mt-3 max-w-2xl text-silver">{description}</p>}
    <div className="mt-8 space-y-6">{children}</div>
  </main>;
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-2xl border border-white/10 bg-card p-5 sm:p-7"><h2 className="mb-5 font-display text-xl font-semibold text-white">{title}</h2>{children}</section>;
}
export function HostNav() {
  return <nav aria-label="Host workspace" className="flex flex-wrap gap-2">{[["/host", "Overview"], ["/host/profile", "Business profile"], ["/host/vehicles", "Vehicles"], ["/host/reservations", "Reservations"], ["/host/team", "Team & owners"]].map(([href, label]) => <Link className="rounded-lg border border-white/15 px-4 py-3 text-sm text-silver hover:border-gold hover:text-white" href={href} key={href}>{label}</Link>)}</nav>;
}
