"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {headers} from "next/headers";
import {z} from "zod";
import {adminExecution,formAdminProof,protectedAdminMutation} from "@/lib/protected-admin";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) throw new Error("Forbidden");
  return session;
}

export async function updateSettings(formData: FormData) {
 try {
  const session = await requireAdmin();
  const execution=adminExecution(session,new Headers(await headers()));
  for(const [key,value]of formData.entries())if(typeof value!=="string"||key.length>100||value.length>4000)throw new Error("Invalid settings input");
  const numeric=z.object({taxRatePercent:z.coerce.number().min(0).max(100),defaultDeposit:z.coerce.number().min(0).max(100000),minimumAge:z.coerce.number().int().min(18).max(100),checkInWindowHours:z.coerce.number().int().min(1).max(720)}).parse(Object.fromEntries(formData));

  const bookingTimezone = String(formData.get("bookingTimezone") || "America/Chicago");
  new Intl.DateTimeFormat("en", { timeZone: bookingTimezone }).format();
  const entries: Array<[string, unknown]> = [
    ["bookingTimezone", bookingTimezone],
    ["businessName", String(formData.get("businessName"))],
    ["phone", String(formData.get("phone"))],
    ["email", String(formData.get("email"))],
    ["address", String(formData.get("address"))],
    ["operatingHours", String(formData.get("operatingHours"))],
    ["taxRatePercent", numeric.taxRatePercent],
    ["defaultDepositCents", Math.round(numeric.defaultDeposit * 100)],
    ["minimumAge", numeric.minimumAge],
    ["checkInWindowHours", numeric.checkInWindowHours],
    ["mileagePolicySummary", String(formData.get("mileagePolicySummary"))],
    ["cancellationPolicySummary", String(formData.get("cancellationPolicySummary"))],
    [
      "socialLinks",
      { instagram: String(formData.get("instagram") || ""), facebook: String(formData.get("facebook") || "") },
    ],
  ];

  await protectedAdminMutation(session.user.id,formAdminProof(formData),execution,"settings",async tx=>{
  await Promise.all(
    entries.map(([key, value]) =>
      tx.siteSetting.upsert({
        where: { key },
        update: { value: value as never },
        create: { key, value: value as never },
      })
    )
  );

  await tx.auditLog.create({
    data: { actorId: session.user.id, action: "settings.update", entityType: "SiteSetting", entityId: "global" },
  });
  });

  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
 } catch { throw new Error("ADMIN_MUTATION_REFUSED"); }
}
