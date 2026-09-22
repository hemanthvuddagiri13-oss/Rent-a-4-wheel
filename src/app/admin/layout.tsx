import { WorkspaceNavigation } from "@/components/layout/workspace-navigation";
import { Logo } from "@/components/layout/logo";
import { auth } from "@/auth";
import { canAccessAdmin } from "@/lib/rbac";
import { redirect } from "next/navigation";

const links = [
  { href: "/admin/operations", label: "Production readiness" },
  { href: "/admin/marketplace", label: "Marketplace operations" },
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/vehicles", label: "Vehicles" },
  { href: "/admin/financial-cases", label: "Financial reconciliation" },
  { href: "/admin/reservations", label: "Reservations" },
  { href: "/admin/calendar", label: "Fleet Calendar" },
  { href: "/admin/owners", label: "Vehicle Owners" },
  { href: "/admin/coupons", label: "Coupons" },
  { href: "/admin/maintenance", label: "Maintenance" },
  { href: "/admin/reviews", label: "Reviews" },
  { href: "/admin/faq", label: "FAQ" },
  { href: "/admin/legal", label: "Legal Documents" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) redirect("/sign-in?callbackUrl=/admin");
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1600px] flex-col lg:flex-row">
      <aside className="min-w-0 shrink-0 border-b border-white/10 bg-surface/60 lg:sticky lg:top-0 lg:max-h-dvh lg:w-64 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="p-5">
          <Logo />
          <p className="mt-1 text-xs uppercase tracking-wide text-gold-bright">Admin</p>
        </div>
        <WorkspaceNavigation label="Administration" collapsible links={links.filter(link=>link.href!=="/admin/operations"||session.user.role==="SUPER_ADMIN")} />
      </aside>
      <main id="main-content" className="min-w-0 flex-1 p-5 sm:p-8">{children}</main>
    </div>
  );
}
