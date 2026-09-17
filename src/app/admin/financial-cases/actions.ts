"use server";
import { auth } from "@/auth";
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
import { revalidatePath } from "next/cache";
export async function resolveCase(form: FormData) {
 const session = await auth(); if (!session?.user) throw new Error("Unauthorized");
 const action = String(form.get("action"));
 if (!["ADOPT","CONFIRM_FAILURE","AUTHORIZE_SETTLEMENT","RELEASE_INVENTORY","ESCALATE","ASSIGN"].includes(action)) throw new Error("Invalid action");
 await resolveFinancialCase(session.user, { caseId: String(form.get("caseId")), action: action as Parameters<typeof resolveFinancialCase>[1]["action"], reason: String(form.get("reason")), providerId: String(form.get("providerId") || ""), assigneeId: String(form.get("assigneeId") || "") });
 revalidatePath("/admin/financial-cases");
}
