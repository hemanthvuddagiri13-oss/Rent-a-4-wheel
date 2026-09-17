import { PublicReviews } from "@/components/marketplace/public-reviews";
import { ActionForm } from "@/components/marketplace/action-form";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fuel, Gauge, Settings2, Users, DoorOpen, CheckCircle2 } from "lucide-react";
import { Gallery } from "@/components/vehicles/gallery";
import { BookingWidget } from "@/components/vehicles/booking-widget";
import { MobileStickyCta } from "@/components/vehicles/mobile-sticky-cta";
import { Badge } from "@/components/ui/badge";
import { getVehicleBySlug } from "@/lib/data/vehicles";
import { formatCurrency } from "@/lib/utils";
import { VEHICLE_CATEGORY_LABELS, SITE_URL } from "@/lib/constants";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const vehicle = await getVehicleBySlug(slug);
  if (!vehicle) return {};

  const title = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? " " + vehicle.trim : ""} Rental`;
  const description = `Rent the ${vehicle.year} ${vehicle.make} ${vehicle.model} in Dallas, TX. From ${formatCurrency(
    vehicle.dailyRateCents
  )}/day. ${vehicle.description ?? ""}`.slice(0, 300);

  return {
    title,
    description,
    alternates: { canonical: `/vehicles/${vehicle.slug}` },
    openGraph: { title, description, url: `${SITE_URL}/vehicles/${vehicle.slug}` },
  };
}

export default async function VehicleDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const vehicle = await getVehicleBySlug(slug);
  if (!vehicle) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Car",
    name: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    brand: vehicle.make,
    model: vehicle.model,
    vehicleModelDate: String(vehicle.year),
    offers: {
      "@type": "Offer",
      priceCurrency: "USD",
      price: (vehicle.dailyRateCents / 100).toFixed(2),
      availability: vehicle.status === "ACTIVE" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `${SITE_URL}/vehicles/${vehicle.slug}`,
    },
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-28 pt-10 sm:px-6 lg:px-8 lg:pb-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge>{VEHICLE_CATEGORY_LABELS[vehicle.category] ?? vehicle.category}</Badge>
        {vehicle.isDemo && <Badge variant="secondary">Sample Vehicle</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <h1 className="font-display text-3xl font-bold text-white sm:text-4xl">
            {vehicle.year} {vehicle.make} {vehicle.model}
            {vehicle.trim ? <span className="text-muted"> {vehicle.trim}</span> : null}
          </h1>

          <div className="mt-6">
            <Gallery
              images={vehicle.images.map((i) => i.url)}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
            />
          </div>

          <div className="mt-8 grid grid-cols-2 gap-4 rounded-xl border border-white/10 bg-card p-5 sm:grid-cols-4">
            <Spec icon={Users} label="Seats" value={String(vehicle.seats)} />
            <Spec icon={DoorOpen} label="Doors" value={String(vehicle.doors)} />
            <Spec icon={Settings2} label="Transmission" value={vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"} />
            <Spec icon={Fuel} label="Fuel" value={titleCase(vehicle.fuelType)} />
            {vehicle.mpg && <Spec icon={Gauge} label="MPG" value={String(vehicle.mpg)} />}
            <Spec icon={Gauge} label="Mileage/Day" value={`${vehicle.mileageAllowancePerDay} mi`} />
          </div>

          {vehicle.description && (
            <div className="mt-8">
              <h2 className="font-display text-xl font-semibold text-white">About This Vehicle</h2>
              <p className="mt-3 leading-relaxed text-muted">{vehicle.description}</p>
            </div>
          )}

          {vehicle.features.length > 0 && (
            <div className="mt-8">
              <h2 className="font-display text-xl font-semibold text-white">Features</h2>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {vehicle.features.map(({ feature }) => (
                  <div key={feature.id} className="flex items-center gap-2 text-sm text-silver">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-gold" /> {feature.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-8 rounded-xl border border-white/10 bg-card p-5">
            <h2 className="font-display text-lg font-semibold text-white">Pricing &amp; Policies</h2>
            <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm sm:grid-cols-3">
              <PolicyRow label="Daily Rate" value={formatCurrency(vehicle.dailyRateCents)} />
              <PolicyRow label="Weekly Rate" value={formatCurrency(vehicle.weeklyRateCents)} />
              <PolicyRow label="Monthly Rate" value={formatCurrency(vehicle.monthlyRateCents)} />
              <PolicyRow label="Security Deposit" value={formatCurrency(vehicle.securityDepositCents)} />
              <PolicyRow label="Mileage Allowance" value={`${vehicle.mileageAllowancePerDay} mi/day`} />
              <PolicyRow
                label="Additional Mileage Fee"
                value={`${formatCurrency(vehicle.additionalMileageFeeCents)}/mi`}
              />
            </dl>
          </div>
        </div>

        <div>
          <BookingWidget vehicleId={vehicle.id} dailyRateCents={vehicle.dailyRateCents} />
        </div>
      </div>

      <PublicReviews vehicleId={vehicle.id} hostId={vehicle.hostId} />
      <section className="my-8 rounded-xl border border-white/10 p-5"><h2 className="mb-4 text-xl">Questions before booking?</h2><ActionForm endpoint="/api/community" action="conversation" values={{vehicleId:vehicle.id}} label="Ask the host" redirectTo="/connect/conversations/:id" /></section>
      <MobileStickyCta dailyRateCents={vehicle.dailyRateCents} />
    </div>
  );
}

function Spec({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <Icon className="h-5 w-5 text-gold" />
      <span className="text-sm font-semibold text-white">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
    </div>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-medium text-white">{value}</dd>
    </div>
  );
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
