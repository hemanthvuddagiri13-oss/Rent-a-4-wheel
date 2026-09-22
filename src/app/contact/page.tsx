import type { Metadata } from "next";
import Link from "next/link";
import { Mail, MessageSquareText, Phone } from "lucide-react";
import { getSiteSettings } from "@/lib/settings";
import { ContactForm } from "@/components/contact/contact-form";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with Rent A 4Wheel — call, text, or send us a message.",
  alternates: { canonical: "/contact" },
};

export default async function ContactPage() {
  const settings = await getSiteSettings();
  const telHref = `tel:${settings.phone.replace(/[^0-9+]/g, "")}`;
  const smsHref = `sms:${settings.phone.replace(/[^0-9+]/g, "")}`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight text-white">Contact Us</h1>
        <p className="mt-3 text-muted">We&apos;re here to help with bookings, questions, and support.</p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {settings.phone && <Button asChild variant="outline" size="lg" className="flex-col gap-1.5 py-6">
              <a href={telHref}>
                <Phone className="h-5 w-5" /> Call
              </a>
            </Button>}
            {settings.phone && <Button asChild variant="outline" size="lg" className="flex-col gap-1.5 py-6">
              <a href={smsHref}>
                <MessageSquareText className="h-5 w-5" /> Text
              </a>
            </Button>}
            {settings.email && <Button asChild variant="outline" size="lg" className="flex-col gap-1.5 py-6">
              <a href={`mailto:${settings.email}`}>
                <Mail className="h-5 w-5" /> Email
              </a>
            </Button>}
          </div>

          <div className="mt-8 rounded-xl border border-white/10 bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-white">Contact options</h2><p className="mt-2 text-sm text-silver">For a booked trip, use your reservation messages or support ticket. Hosts coordinate physical pickup and return.</p><Link className="mt-3 inline-flex min-h-11 items-center underline" href="/connect?view=support">Open support</Link>
            <p className="mt-2 text-sm text-muted">{settings.address}</p>
            <p className="text-sm text-muted">{settings.operatingHours}</p>
            <p className="mt-3 text-sm text-silver">{settings.phone}</p>
            <p className="text-sm text-silver">{settings.email}</p>
          </div>

          <p className="mt-6 text-sm text-muted">
            Have a general question?{" "}
            <Link href="/faq" className="text-gold underline underline-offset-4">
              Check our FAQ
            </Link>
            .
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-6">
          <h2 className="font-display text-lg font-semibold text-white">Send a Message</h2>
          <div className="mt-4">
            <ContactForm />
          </div>
        </div>
      </div>
    </div>
  );
}
