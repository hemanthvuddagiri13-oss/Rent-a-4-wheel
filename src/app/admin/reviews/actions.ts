"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) throw new Error("Forbidden");
  return session;
}

export async function togglePublished(reviewId: string, isPublished: boolean) {
  await requireAdmin();
  if (isPublished) throw new Error("Legacy reviews lack verified trip evidence and cannot be published.");
  await prisma.review.update({ where: { id: reviewId }, data: { isPublished: false } });
  revalidatePath("/admin/reviews");
  revalidatePath("/");
}

export async function createReview(formData: FormData) {
  void formData;
  await requireAdmin();
  throw new Error("Reviews must be submitted by verified trip participants.");
}
