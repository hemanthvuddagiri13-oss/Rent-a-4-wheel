"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type WorkspaceLink = { href: string; label: string };
export function WorkspaceNavigation({ links, label, collapsible = false }: { links: WorkspaceLink[]; label: string; collapsible?: boolean }) {
  const pathname = usePathname();
  const items = links.map(link => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined}
    className={cn("flex min-h-11 min-w-0 items-center rounded-lg px-3 py-3 text-sm font-medium text-silver hover:bg-white/5", pathname === link.href && "bg-white/10 text-white")}>{link.label}</Link>);
  if (!collapsible) return <nav aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-white/10 p-2">{items}</nav>;
  return <>
    <details className="px-4 pb-4 lg:hidden">
      <summary className="min-h-11 cursor-pointer rounded-lg border border-white/15 px-4 py-3 text-sm font-semibold">{label}</summary>
      <nav aria-label={label} className="mt-2 grid gap-1 sm:grid-cols-2">{items}</nav>
    </details>
    <nav aria-label={label} className="hidden space-y-1 px-3 pb-6 lg:block">{items}</nav>
  </>;
}
