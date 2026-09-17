import Link from "next/link";
import {
  LayoutDashboard,
  Car,
  CalendarRange,
  Users,
  Ticket,
  Wrench,
  Settings,
  Star,
  HelpCircle,
  FileText,
  ClipboardList,
} from "lucide-react";
import { Logo } from "@/components/layout/logo";

const links = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/vehicles", label: "Vehicles", icon: Car },
  { href: "/admin/financial-cases", label: "Financial reconciliation", icon: ClipboardList },
  { href: "/admin/reservations", label: "Reservations", icon: ClipboardList },
  { href: "/admin/calendar", label: "Fleet Calendar", icon: CalendarRange },
  { href: "/admin/owners", label: "Vehicle Owners", icon: Users },
  { href: "/admin/coupons", label: "Coupons", icon: Ticket },
  { href: "/admin/maintenance", label: "Maintenance", icon: Wrench },
  { href: "/admin/reviews", label: "Reviews", icon: Star },
  { href: "/admin/faq", label: "FAQ", icon: HelpCircle },
  { href: "/admin/legal", label: "Legal Documents", icon: FileText },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-white/10 bg-surface/60 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="p-5">
          <Logo />
          <p className="mt-1 text-xs uppercase tracking-wide text-gold-bright">Admin</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-6">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-2.5 text-sm font-medium text-silver hover:bg-white/5 hover:text-gold-bright"
            >
              <link.icon className="h-4 w-4" />
              {link.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 p-5 sm:p-8">{children}</div>
    </div>
  );
}
