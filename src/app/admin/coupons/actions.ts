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

export async function createCoupon(formData: FormData) {
  const session = await requireAdmin();
  const discountType = String(formData.get("discountType")) as "PERCENTAGE" | "FIXED";

  const coupon = await prisma.coupon.create({
    data: {
      code: String(formData.get("code")).toUpperCase(),
      discountType,
      amountCents: discountType === "FIXED" ? Math.round(Number(formData.get("amount")) * 100) : null,
      percent: discountType === "PERCENTAGE" ? Number(formData.get("percent")) : null,
      startsAt: new Date(String(formData.get("startsAt"))),
      expiresAt: new Date(String(formData.get("expiresAt"))),
      minRentalDays: formData.get("minRentalDays") ? Number(formData.get("minRentalDays")) : null,
      maxUses: formData.get("maxUses") ? Number(formData.get("maxUses")) : null,
      applicableVehicleIds: [],
      isActive: formData.get("isActive") === "on",
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "coupon.create", entityType: "Coupon", entityId: coupon.id },
  });

  revalidatePath("/admin/coupons");
  redirect("/admin/coupons");
}

export async function toggleCoupon(couponId: string, isActive: boolean) {
  await requireAdmin();
  await prisma.coupon.update({ where: { id: couponId }, data: { isActive } });
  revalidatePath("/admin/coupons");
}
