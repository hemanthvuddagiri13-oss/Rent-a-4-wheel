import Link from "next/link";
import { Mail, MapPin, Phone } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import type { SiteSettings } from "@/lib/settings";

function InstagramIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FacebookIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M15 3h-2a5 5 0 0 0-5 5v2H6v4h2v7h4v-7h3l1-4h-4V8a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

const columns = [
  {
    title: "Company",
    links: [
      { href: "/", label: "Home" },
      { href: "/vehicles", label: "Vehicles" },
      { href: "/how-it-works", label: "How It Works" },
      { href: "/long-term-rentals", label: "Long-Term Rentals" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Support",
    links: [
      { href: "/faq", label: "FAQ" },
      { href: "/account", label: "My Account" },
      { href: "/contact", label: "Contact Support" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms-and-conditions", label: "Terms & Conditions" },
      { href: "/legal/privacy-policy", label: "Privacy Policy" },
      { href: "/legal/cancellation-policy", label: "Cancellation Policy" },
      { href: "/legal/insurance-policy", label: "Insurance Policy" },
      { href: "/legal/damage-policy", label: "Damage Policy" },
      { href: "/legal/security-deposit-policy", label: "Security Deposit Policy" },
    ],
  },
];

export function Footer({ settings }: { settings: SiteSettings }) {
  return (
    <footer className="border-t border-white/10 bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 lg:col-span-1">
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              Drive More Possibilities. A car-sharing marketplace connecting guests with independent vehicle hosts.
            </p>
            <div className="mt-5 flex flex-col gap-2 text-sm text-silver">
              {settings.phone && <a href={`tel:${settings.phone.replace(/[^0-9+]/g, "")}`} className="flex items-center gap-2 hover:text-gold-bright">
                <Phone className="h-4 w-4 text-gold" /> {settings.phone}
              </a>}
              {settings.email && <a href={`mailto:${settings.email}`} className="flex items-center gap-2 hover:text-gold-bright">
                <Mail className="h-4 w-4 text-gold" /> {settings.email}
              </a>}
              {settings.address && <span className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-gold" /> {settings.address}
              </span>}
            </div>
            <div className="mt-5 flex gap-3">
              {settings.socialLinks?.instagram && (
                <a href={settings.socialLinks.instagram} aria-label="Instagram" className="text-muted hover:text-gold-bright">
                  <InstagramIcon className="h-5 w-5" />
                </a>
              )}
              {settings.socialLinks?.facebook && (
                <a href={settings.socialLinks.facebook} aria-label="Facebook" className="text-muted hover:text-gold-bright">
                  <FacebookIcon className="h-5 w-5" />
                </a>
              )}
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-gold-bright">
                {col.title}
              </h3>
              <ul className="mt-3 space-y-1">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="inline-flex min-h-11 items-center text-sm text-muted hover:text-white">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs text-muted sm:flex-row">
          <p>&copy; {new Date().getFullYear()} Rent A 4Wheel. All rights reserved.</p>
          <p>{settings.operatingHours}</p>
        </div>
      </div>
    </footer>
  );
}
