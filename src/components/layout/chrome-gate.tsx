"use client";

import { usePathname } from "next/navigation";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import type { SiteSettings } from "@/lib/settings";

export function ChromeGate({ settings, children }: { settings: SiteSettings; children: React.ReactNode }) {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith("/admin");

  if (isAdmin) {
    return <>{children}</>;
  }

  return (
    <>
      <Navbar phone={settings.phone} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <Footer settings={settings} />
    </>
  );
}
