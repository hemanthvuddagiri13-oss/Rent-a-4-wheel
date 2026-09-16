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

export async function createFaq(formData: FormData) {
  await requireAdmin();
  const categoryName = String(formData.get("category"));

  const category = await prisma.faqCategory.upsert({
    where: { name: categoryName },
    update: {},
    create: { name: categoryName },
  });

  await prisma.faq.create({
    data: {
      categoryId: category.id,
      question: String(formData.get("question")),
      answer: String(formData.get("answer")),
    },
  });

  revalidatePath("/admin/faq");
  revalidatePath("/faq");
  redirect("/admin/faq");
}

export async function deleteFaq(faqId: string) {
  await requireAdmin();
  await prisma.faq.delete({ where: { id: faqId } });
  revalidatePath("/admin/faq");
  revalidatePath("/faq");
}
