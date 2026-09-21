import { getSiteSettings } from "@/lib/settings";
import { visibleJurisdictions } from "@/lib/jurisdiction";
import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BookingWizard } from "@/components/booking/booking-wizard";
import type { BookingExtra, BookingVehicle } from "@/components/booking/types";

export const metadata: Metadata = { title: "Book Your Rental", robots: { index: false } };

export default async function BookPage({ params }: { params: Promise<{ vehicleId: string }> }) {
  const { vehicleId } = await params;

  const vehicleRecord = await prisma.vehicle.findUnique({
    where: { id: vehicleId, jurisdictionCode: {in: await visibleJurisdictions()} },
    include: { images: { orderBy: { position: "asc" }, take: 1 } },
  });
  if (!vehicleRecord || vehicleRecord.status !== "ACTIVE") notFound();

  const extraRecords = await prisma.extra.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });

  const vehicle: BookingVehicle = {
    id: vehicleRecord.id,
    slug: vehicleRecord.slug,
    year: vehicleRecord.year,
    make: vehicleRecord.make,
    model: vehicleRecord.model,
    trim: vehicleRecord.trim,
    dailyRateCents: vehicleRecord.dailyRateCents,
    weeklyRateCents: vehicleRecord.weeklyRateCents,
    monthlyRateCents: vehicleRecord.monthlyRateCents,
    securityDepositCents: vehicleRecord.securityDepositCents,
    imageUrl: vehicleRecord.images[0]?.url ?? null,
  };

  const extras: BookingExtra[] = extraRecords.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    chargeType: e.chargeType,
    amountCents: e.amountCents,
    percent: e.percent ? Number(e.percent) : null,
  }));

  return (
    <Suspense fallback={null}>
      <BookingWizard vehicle={vehicle} extras={extras} bookingTimezone={(await getSiteSettings()).bookingTimezone} />
    </Suspense>
  );
}
