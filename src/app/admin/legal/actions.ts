"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canManageSettings } from "@/lib/rbac";
import type { LegalDocumentType } from "@prisma/client";
import { createHash } from "node:crypto";

export async function updateLegalDocument(formData: FormData) {
  const session = await auth();
  if (!session?.user || !canManageSettings(session.user.role)) throw new Error("Forbidden");

  const type = String(formData.get("type")) as LegalDocumentType;
  const content = String(formData.get("content"));
  const version = String(formData.get("version"));
  const needsAttorneyReview = formData.get("needsAttorneyReview") === "on";
  const reviewReference = String(formData.get("reviewReference") || "").trim();
  if (!version.trim() || !content.trim() || content.length > 100000) throw new Error("A version and legal text are required.");
  if (!needsAttorneyReview && (reviewReference.length < 10 || content.includes("NOT APPROVED FOR PRODUCTION") || content.includes("PLACEHOLDER"))) throw new Error("Replace draft text and record the Texas attorney approval reference before enabling signing.");

  await prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT "id" FROM "LegalDocument" WHERE "type"::text=${type} FOR UPDATE`;
  const prior = await tx.legalDocument.findUniqueOrThrow({ where: { type } });
  if (prior.content !== content && prior.version === version) throw new Error("Changed legal text requires a new version.");
  await tx.legalDocument.update({
    where: { type },
    data: { content, version, needsAttorneyReview, updatedById: session.user.id },
  });

  await tx.auditLog.create({
    data: { actorId: session.user.id, action: "legal.update", entityType: "LegalDocument", entityId: type,
      metadata: { previousVersion: prior.version, version, contentHash: createHash("sha256").update(content).digest("hex"), needsAttorneyReview, reviewReference } },
  });
  });

  revalidatePath("/admin/legal");
  revalidatePath("/legal/[type]", "page");
}
