"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Menu, ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const discovery = [{ href: "/vehicles", label: "Find a car" }, { href: "/how-it-works", label: "How it works" }, { href: "/contact", label: "Help" }];
export function Navbar() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";
  const role = session?.user?.role;
  // Navigation is a convenience. Every destination still checks the current session and role.
  const accountLinks = signedIn ? [
    { href: "/account", label: "My trips" }, { href: "/connect", label: "Messages & help" },
    { href: "/connect?view=notifications", label: "Notifications" }, { href: "/account/security", label: "Account security" },
    ...(["HOST", "HOST_EMPLOYEE"].includes(role ?? "") ? [{ href: "/host", label: "Host workspace" }] : [{ href: "/host", label: "Become a host" }]),
    ...(["STAFF", "ADMIN", "SUPER_ADMIN"].includes(role ?? "") ? [{ href: "/admin", label: "Administration" }] : []),
    ...(["FINANCE_AGENT", "ADMIN", "SUPER_ADMIN"].includes(role ?? "") ? [{ href: "/finance/admin", label: "Financial administration" }] : []),
  ] : [{ href: "/sign-in", label: "Sign in" }, { href: "/host", label: "Become a host" }];
  return <header className="sticky top-0 z-40 border-b border-white/10 bg-background/95 backdrop-blur-md">
    <nav aria-label="Main navigation" className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
      <Logo />
      <ul className="hidden items-center gap-2 lg:flex">{discovery.map(link => <li key={link.href}><Link href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={cn("inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-silver hover:bg-white/5", pathname === link.href && "text-gold")}>{link.label}</Link></li>)}</ul>
      <div className="flex shrink-0 items-center gap-2">
        <Button asChild variant="outline" className="hidden sm:inline-flex"><Link href={signedIn ? "/account" : "/sign-in"}>{signedIn ? "My trips" : "Sign in"}</Link></Button>
        <Sheet>
          <SheetTrigger asChild><Button variant="ghost" size="icon" aria-label="Open menu"><Menu className="h-6 w-6" /></Button></SheetTrigger>
          <SheetContent side="right" className="flex w-[min(90vw,24rem)] flex-col">
            <SheetTitle>Explore Rent A 4Wheel</SheetTitle>
            <nav aria-label="Explore and account" className="mt-6 space-y-6">
              <div className="space-y-1">{discovery.map(link => <SheetClose asChild key={link.href}><Link className="flex min-h-11 items-center rounded-lg px-3 py-3 text-silver hover:bg-white/5" href={link.href}>{link.label}</Link></SheetClose>)}</div>
              <div className="space-y-1 border-t border-white/10 pt-5"><p className="px-3 pb-2 text-sm text-muted">{signedIn ? "Your account" : "Get started"}</p>{accountLinks.map(link => <SheetClose asChild key={link.href}><Link className="flex min-h-11 items-center rounded-lg px-3 py-3 text-silver hover:bg-white/5" href={link.href}>{link.label}</Link></SheetClose>)}</div>
            </nav>
            <div className="mt-auto pt-6"><SheetClose asChild><Button asChild className="w-full"><Link href="/vehicles">Find your next car <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link></Button></SheetClose></div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  </header>;
}
