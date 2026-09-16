import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name: z.string().trim().min(1).optional(),
  phone: z.string().trim().optional(),
  addressLine1: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().max(2).optional(),
  zip: z.string().trim().optional(),
});

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { name, phone, addressLine1, city, state, zip } = parsed.data;

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      name,
      phone,
      customer: {
        upsert: {
          create: { addressLine1, city, state, zip },
          update: { addressLine1, city, state, zip },
        },
      },
    },
  });

  return NextResponse.json({ success: true });
}
