"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Phone } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { NAV_LINKS } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function Navbar({ phone }: { phone: string }) {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full transition-all duration-300",
        scrolled ? "glass shadow-[0_4px_30px_rgba(0,0,0,0.4)]" : "bg-transparent"
      )}
    >
      <nav className="mx-auto flex h-18 max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Logo />

        <ul className="hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={cn(
                  "text-sm font-medium tracking-wide text-silver transition-colors hover:text-gold-bright",
                  pathname === link.href && "text-gold-bright"
                )}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-3 lg:flex">
          <a
            href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
            className="flex items-center gap-2 text-sm font-medium text-silver hover:text-gold-bright"
          >
            <Phone className="h-4 w-4 text-gold" />
            {phone}
          </a>
          <Button asChild size="default">
            <Link href="/vehicles">Book a Car</Link>
          </Button>
        </div>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
              <Menu className="h-6 w-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="flex flex-col">
            <SheetTitle>Menu</SheetTitle>
            <div className="mt-6 flex flex-col gap-1">
              {NAV_LINKS.map((link) => (
                <SheetClose asChild key={link.href}>
                  <Link
                    href={link.href}
                    className="rounded-md px-3 py-3 text-base font-medium text-silver hover:bg-white/5 hover:text-gold-bright"
                  >
                    {link.label}
                  </Link>
                </SheetClose>
              ))}
            </div>
            <div className="mt-auto flex flex-col gap-3 border-t border-white/10 pt-6">
              <a
                href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
                className="flex items-center justify-center gap-2 text-sm font-medium text-silver"
              >
                <Phone className="h-4 w-4 text-gold" /> {phone}
              </a>
              <SheetClose asChild>
                <Button asChild size="lg" className="w-full">
                  <Link href="/vehicles">Book a Car</Link>
                </Button>
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </header>
  );
}
