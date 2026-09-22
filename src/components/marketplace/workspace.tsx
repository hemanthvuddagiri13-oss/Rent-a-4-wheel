import { WorkspaceNavigation } from "@/components/layout/workspace-navigation";
import type { ReactNode } from "react";

export function Workspace({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children: ReactNode }) {
  return <div className="mx-auto min-w-0 max-w-7xl [overflow-wrap:anywhere] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
    <p className="text-xs font-semibold uppercase tracking-[.22em] text-gold-bright">{eyebrow}</p>
    <h1 className="mt-3 font-display text-3xl font-semibold text-white sm:text-4xl">{title}</h1>
    {description && <p className="mt-3 max-w-2xl text-silver">{description}</p>}
    <div className="mt-8 space-y-6">{children}</div>
  </div>;
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-2xl border border-white/10 bg-card p-5 sm:p-7"><h2 className="mb-5 font-display text-xl font-semibold text-white">{title}</h2>{children}</section>;
}
export function HostNav() {
  return <WorkspaceNavigation label="Host workspace" links={[["/host", "Overview"], ["/host/profile", "Profile"], ["/host/vehicles", "Vehicles"], ["/host/reservations", "Trips"], ["/connect", "Messages"], ["/host/team", "Team & owners"], ["/finance", "Earnings & payouts"]].map(([href,label])=>({href,label}))} />;
}
