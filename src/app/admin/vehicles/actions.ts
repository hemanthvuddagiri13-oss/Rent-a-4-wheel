"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { BLOCKING_RESERVATION_STATUSES } from "@/lib/reservation-state-machine";
import type { VehicleCategory, Transmission, FuelType, VehicleStatus, OwnershipType } from "@prisma/client";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) {
    throw new Error("Forbidden");
  }
  return session;
}

function parseImageUrls(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createVehicle(formData: FormData) {
  const session = await requireAdmin();

  const year = Number(formData.get("year"));
  const make = String(formData.get("make"));
  const model = String(formData.get("model"));
  const slugBase = slugify(`${year}-${make}-${model}`);
  let slug = slugBase;
  let suffix = 1;
  while (await prisma.vehicle.findUnique({ where: { slug } })) {
    slug = `${slugBase}-${suffix++}`;
  }

  const imageUrls = parseImageUrls(String(formData.get("imageUrls") ?? ""));

  const vehicle = await prisma.vehicle.create({
    data: {
      slug,
      vin: String(formData.get("vin")),
      licensePlate: String(formData.get("licensePlate")),
      year,
      make,
      model,
      trim: String(formData.get("trim") || "") || null,
      color: String(formData.get("color") || "") || null,
      mileage: Number(formData.get("mileage") || 0),
      category: String(formData.get("category")) as VehicleCategory,
      transmission: String(formData.get("transmission")) as Transmission,
      fuelType: String(formData.get("fuelType")) as FuelType,
      seats: Number(formData.get("seats") || 5),
      doors: Number(formData.get("doors") || 4),
      mpg: formData.get("mpg") ? Number(formData.get("mpg")) : null,
      description: String(formData.get("description") || "") || null,
      status: String(formData.get("status")) as VehicleStatus,
      dailyRateCents: Math.round(Number(formData.get("dailyRate")) * 100),
      weeklyRateCents: Math.round(Number(formData.get("weeklyRate")) * 100),
      monthlyRateCents: Math.round(Number(formData.get("monthlyRate")) * 100),
      securityDepositCents: Math.round(Number(formData.get("securityDeposit") || 0) * 100),
      mileageAllowancePerDay: Number(formData.get("mileageAllowancePerDay") || 150),
      additionalMileageFeeCents: Math.round(Number(formData.get("additionalMileageFee") || 0) * 100),
      ownershipType: String(formData.get("ownershipType")) as OwnershipType,
      ownerId: String(formData.get("ownerId") || "") || null,
      registrationExpiresAt: formData.get("registrationExpiresAt") ? new Date(String(formData.get("registrationExpiresAt"))) : null,
      insuranceExpiresAt: formData.get("insuranceExpiresAt") ? new Date(String(formData.get("insuranceExpiresAt"))) : null,
      inspectionExpiresAt: formData.get("inspectionExpiresAt") ? new Date(String(formData.get("inspectionExpiresAt"))) : null,
      availability: { create: {} },
      images: { create: imageUrls.map((url, i) => ({ url, position: i, isPrimary: i === 0 })) },
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "vehicle.create", entityType: "Vehicle", entityId: vehicle.id },
  });

  revalidatePath("/admin/vehicles");
  redirect("/admin/vehicles");
}

export async function updateVehicle(vehicleId: string, formData: FormData) {
  const session = await requireAdmin();

  const imageUrls = parseImageUrls(String(formData.get("imageUrls") ?? ""));

  await prisma.$transaction(async (tx) => {
    await tx.vehicle.update({
      where: { id: vehicleId },
      data: {
        vin: String(formData.get("vin")),
        licensePlate: String(formData.get("licensePlate")),
        year: Number(formData.get("year")),
        make: String(formData.get("make")),
        model: String(formData.get("model")),
        trim: String(formData.get("trim") || "") || null,
        color: String(formData.get("color") || "") || null,
        mileage: Number(formData.get("mileage") || 0),
        category: String(formData.get("category")) as VehicleCategory,
        transmission: String(formData.get("transmission")) as Transmission,
        fuelType: String(formData.get("fuelType")) as FuelType,
        seats: Number(formData.get("seats") || 5),
        doors: Number(formData.get("doors") || 4),
        mpg: formData.get("mpg") ? Number(formData.get("mpg")) : null,
        description: String(formData.get("description") || "") || null,
        status: String(formData.get("status")) as VehicleStatus,
        dailyRateCents: Math.round(Number(formData.get("dailyRate")) * 100),
        weeklyRateCents: Math.round(Number(formData.get("weeklyRate")) * 100),
        monthlyRateCents: Math.round(Number(formData.get("monthlyRate")) * 100),
        securityDepositCents: Math.round(Number(formData.get("securityDeposit") || 0) * 100),
        mileageAllowancePerDay: Number(formData.get("mileageAllowancePerDay") || 150),
        additionalMileageFeeCents: Math.round(Number(formData.get("additionalMileageFee") || 0) * 100),
        ownershipType: String(formData.get("ownershipType")) as OwnershipType,
        ownerId: String(formData.get("ownerId") || "") || null,
        registrationExpiresAt: formData.get("registrationExpiresAt") ? new Date(String(formData.get("registrationExpiresAt"))) : null,
        insuranceExpiresAt: formData.get("insuranceExpiresAt") ? new Date(String(formData.get("insuranceExpiresAt"))) : null,
        inspectionExpiresAt: formData.get("inspectionExpiresAt") ? new Date(String(formData.get("inspectionExpiresAt"))) : null,
      },
    });

    if (imageUrls.length > 0) {
      await tx.vehicleImage.deleteMany({ where: { vehicleId } });
      await tx.vehicleImage.createMany({
        data: imageUrls.map((url, i) => ({ vehicleId, url, position: i, isPrimary: i === 0 })),
      });
    }

    await tx.auditLog.create({
      data: { actorId: session.user.id, action: "vehicle.update", entityType: "Vehicle", entityId: vehicleId },
    });
  });

  revalidatePath("/admin/vehicles");
  revalidatePath(`/admin/vehicles/${vehicleId}`);
  redirect("/admin/vehicles");
}

export async function setVehicleStatus(vehicleId: string, status: VehicleStatus) {
  const session = await requireAdmin();
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { status } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "vehicle.status_change", entityType: "Vehicle", entityId: vehicleId, metadata: { status } },
  });
  revalidatePath("/admin/vehicles");
}

export async function deleteVehicle(vehicleId: string) {
  const session = await requireAdmin();
  const activeReservations = await prisma.reservation.count({
    where: { vehicleId, status: { in: BLOCKING_RESERVATION_STATUSES } },
  });
  if (activeReservations > 0) {
    throw new Error("Cannot delete a vehicle with active or upcoming reservations. Retire it instead.");
  }
  await prisma.vehicle.delete({ where: { id: vehicleId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "vehicle.delete", entityType: "Vehicle", entityId: vehicleId },
  });
  revalidatePath("/admin/vehicles");
}
