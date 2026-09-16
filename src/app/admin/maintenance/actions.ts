"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { MaintenanceType } from "@prisma/client";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) throw new Error("Forbidden");
  return session;
}

export async function createMaintenanceRecord(formData: FormData) {
  const session = await requireAdmin();
  const vehicleId = String(formData.get("vehicleId"));

  const record = await prisma.maintenanceRecord.create({
    data: {
      vehicleId,
      service: String(formData.get("service")) as MaintenanceType,
      serviceDate: new Date(String(formData.get("serviceDate"))),
      mileage: Number(formData.get("mileage")),
      costCents: Math.round(Number(formData.get("cost") || 0) * 100),
      vendor: String(formData.get("vendor") || "") || null,
      nextServiceDate: formData.get("nextServiceDate") ? new Date(String(formData.get("nextServiceDate"))) : null,
      nextServiceMileage: formData.get("nextServiceMileage") ? Number(formData.get("nextServiceMileage")) : null,
      notes: String(formData.get("notes") || "") || null,
    },
  });

  if (String(formData.get("service")) === "REGISTRATION" && formData.get("nextServiceDate")) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { registrationExpiresAt: new Date(String(formData.get("nextServiceDate"))) } });
  }
  if (String(formData.get("service")) === "INSURANCE" && formData.get("nextServiceDate")) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { insuranceExpiresAt: new Date(String(formData.get("nextServiceDate"))) } });
  }
  if (String(formData.get("service")) === "INSPECTION" && formData.get("nextServiceDate")) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { inspectionExpiresAt: new Date(String(formData.get("nextServiceDate"))) } });
  }

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "maintenance.create", entityType: "MaintenanceRecord", entityId: record.id },
  });

  revalidatePath("/admin/maintenance");
  redirect("/admin/maintenance");
}
