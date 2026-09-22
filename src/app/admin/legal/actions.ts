"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {headers} from "next/headers";
import {LegalDocumentType} from "@prisma/client";
import {z} from "zod";
import {adminExecution,formAdminProof,protectedAdminMutation} from "@/lib/protected-admin";
import { createHash } from "node:crypto";

export async function updateLegalDocument(formData: FormData) {
 try {
  const session = await auth();
  if (!session?.user) throw new Error("Forbidden");
  const execution=adminExecution(session,new Headers(await headers()));

  const type = z.nativeEnum(LegalDocumentType).parse(formData.get("type"));
  const content = z.string().trim().min(1).max(100000).parse(formData.get("content"));
  const version = z.string().trim().min(1).max(100).parse(formData.get("version"));
  const needsAttorneyReview = formData.get("needsAttorneyReview") === "on";
  const reviewReference = z.string().trim().max(500).parse(String(formData.get("reviewReference") || ""));
  if (!version.trim() || !content.trim() || content.length > 100000) throw new Error("A version and legal text are required.");
  if (!needsAttorneyReview && (reviewReference.length < 10 || content.includes("NOT APPROVED FOR PRODUCTION") || content.includes("PLACEHOLDER"))) throw new Error("Replace draft text and record the applicable attorney approval reference before enabling signing.");

  await protectedAdminMutation(session.user.id,formAdminProof(formData),execution,"legal",async tx => {
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
 } catch { throw new Error("ADMIN_MUTATION_REFUSED"); }
}
