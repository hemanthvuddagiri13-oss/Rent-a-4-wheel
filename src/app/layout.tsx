import type { Metadata } from "next";
import { Inter, Oswald } from "next/font/google";
import { Toaster } from "sonner";
import { AuthSessionProvider } from "@/components/auth/session-provider";
import { SiteChrome } from "@/components/layout/site-chrome";
import { SITE_URL } from "@/lib/constants";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const oswald = Oswald({ variable: "--font-oswald", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Rent A 4Wheel | Daily, Weekly & Monthly Car Rentals in Dallas, TX",
    template: "%s | Rent A 4Wheel",
  },
  description:
    "Clean, reliable vehicles with flexible daily, weekly, and monthly rental options at competitive rates in Dallas, Texas.",
  keywords: [
    "car rental Dallas",
    "affordable car rental Dallas",
    "daily car rental Dallas",
    "weekly car rental Dallas",
    "monthly car rental Dallas",
    "SUV rental Dallas",
    "long term car rental Dallas",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Rent A 4Wheel",
    title: "Rent A 4Wheel | Dallas Car Rentals",
    description: "Daily, weekly & monthly car rentals in Dallas, TX. Drive more possibilities.",
    url: SITE_URL,
    images: [{ url: "/brand/logo.svg", width: 560, height: 120, alt: "Rent A 4Wheel" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rent A 4Wheel | Dallas Car Rentals",
    description: "Daily, weekly & monthly car rentals in Dallas, TX.",
  },
  robots: { index: true, follow: true },
};

const localBusinessJsonLd = {
  "@context": "https://schema.org",
  "@type": "AutoRental",
  name: "Rent A 4Wheel",
  url: SITE_URL,
  image: `${SITE_URL}/brand/logo.svg`,
  telephone: "(214) 555-0123",
  areaServed: "Dallas, TX",
  address: { "@type": "PostalAddress", addressLocality: "Dallas", addressRegion: "TX", addressCountry: "US" },
  priceRange: "$$",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${oswald.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd) }} />
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
