import type { Metadata } from "next";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { AuthSessionProvider } from "@/components/auth/session-provider";
import { SiteChrome } from "@/components/layout/site-chrome";
import { SITE_URL } from "@/lib/constants";
import "./globals.css";


export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Rent A 4Wheel | Drive More Possibilities",
    template: "%s | Rent A 4Wheel",
  },
  description:
    "Find cars from independent hosts. Explore trip options, review itemized pricing and manage your booking with Rent A 4Wheel.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Rent A 4Wheel",
    title: "Rent A 4Wheel | Drive More Possibilities",
    description: "A car-sharing marketplace built around your next trip. Drive More Possibilities.",
    url: SITE_URL,
    images: [{ url: "/brand/logo.svg", width: 560, height: 120, alt: "Rent A 4Wheel" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rent A 4Wheel | Drive More Possibilities",
    description: "Explore cars from independent hosts with Rent A 4Wheel.",
  },
  robots: { index: true, follow: true },
};

const marketplaceJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Rent A 4Wheel",
  url: SITE_URL,
  image: `${SITE_URL}/brand/logo.svg`,

};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // A per-request CSP nonce must never be reused from a prerendered document.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <script nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(marketplaceJsonLd) }} />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-gold focus:px-4 focus:py-2 focus:text-black"
        >
          Skip to content
        </a>
        <AuthSessionProvider>
          <SiteChrome>{children}</SiteChrome>
          <Toaster theme="dark" position="top-center" richColors />
        </AuthSessionProvider>
      </body>
    </html>
  );
}
