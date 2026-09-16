"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canManageSettings } from "@/lib/rbac";
import type { LegalDocumentType } from "@prisma/client";

export async function updateLegalDocument(formData: FormData) {
  const session = await auth();
  if (!session?.user || !canManageSettings(session.user.role)) throw new Error("Forbidden");

  const type = String(formData.get("type")) as LegalDocumentType;
  const content = String(formData.get("content"));
  const version = String(formData.get("version"));
  const needsAttorneyReview = formData.get("needsAttorneyReview") === "on";

  await prisma.legalDocument.update({
    where: { type },
    data: { content, version, needsAttorneyReview, updatedById: session.user.id },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "legal.update", entityType: "LegalDocument", entityId: type },
  });

  revalidatePath("/admin/legal");
  revalidatePath("/legal/[type]", "page");
}
