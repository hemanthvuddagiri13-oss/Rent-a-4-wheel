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

export async function togglePublished(reviewId: string, isPublished: boolean) {
  await requireAdmin();
  await prisma.review.update({ where: { id: reviewId }, data: { isPublished } });
  revalidatePath("/admin/reviews");
  revalidatePath("/");
}

export async function createReview(formData: FormData) {
  const session = await requireAdmin();
  await prisma.review.create({
    data: {
      authorName: String(formData.get("authorName")),
      rating: Number(formData.get("rating")),
      comment: String(formData.get("comment")),
      isPublished: formData.get("isPublished") === "on",
    },
  });
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "review.create", entityType: "Review", entityId: "n/a" } });
  revalidatePath("/admin/reviews");
  redirect("/admin/reviews");
}
