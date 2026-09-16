"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canManageSettings } from "@/lib/rbac";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canManageSettings(session.user.role)) throw new Error("Forbidden");
  return session;
}

export async function updateSettings(formData: FormData) {
  const session = await requireAdmin();

  const entries: Array<[string, unknown]> = [
    ["businessName", String(formData.get("businessName"))],
    ["phone", String(formData.get("phone"))],
    ["email", String(formData.get("email"))],
    ["address", String(formData.get("address"))],
    ["operatingHours", String(formData.get("operatingHours"))],
    ["taxRatePercent", Number(formData.get("taxRatePercent"))],
    ["defaultDepositCents", Math.round(Number(formData.get("defaultDeposit")) * 100)],
    ["minimumAge", Number(formData.get("minimumAge"))],
    ["mileagePolicySummary", String(formData.get("mileagePolicySummary"))],
    ["cancellationPolicySummary", String(formData.get("cancellationPolicySummary"))],
    [
      "socialLinks",
      { instagram: String(formData.get("instagram") || ""), facebook: String(formData.get("facebook") || "") },
    ],
  ];

  await Promise.all(
    entries.map(([key, value]) =>
      prisma.siteSetting.upsert({
        where: { key },
        update: { value: value as never },
        create: { key, value: value as never },
      })
    )
  );

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "settings.update", entityType: "SiteSetting", entityId: "global" },
  });

  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
}
