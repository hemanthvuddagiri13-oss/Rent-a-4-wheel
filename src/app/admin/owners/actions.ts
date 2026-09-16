"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) throw new Error("Forbidden");
  return session;
}

export async function createOwner(formData: FormData) {
  const session = await requireAdmin();
  const owner = await prisma.vehicleOwner.create({
    data: {
      name: String(formData.get("name")),
      email: String(formData.get("email") || "") || null,
      phone: String(formData.get("phone") || "") || null,
      notes: String(formData.get("notes") || "") || null,
    },
  });

  const startDate = formData.get("agreementStart");
  if (startDate) {
    await prisma.ownerAgreement.create({
      data: {
        ownerId: owner.id,
        startDate: new Date(String(startDate)),
        endDate: formData.get("agreementEnd") ? new Date(String(formData.get("agreementEnd"))) : null,
        paymentArrangement: String(formData.get("paymentArrangement") || "MONTHLY_FIXED") as "MONTHLY_FIXED" | "REVENUE_SHARE",
        monthlyFixedCents: formData.get("monthlyFixed") ? Math.round(Number(formData.get("monthlyFixed")) * 100) : null,
        revenueSharePercent: formData.get("revenueShare") ? Number(formData.get("revenueShare")) : null,
        notes: String(formData.get("agreementNotes") || "") || null,
      },
    });
  }

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "owner.create", entityType: "VehicleOwner", entityId: owner.id },
  });

  revalidatePath("/admin/owners");
  redirect("/admin/owners");
}
