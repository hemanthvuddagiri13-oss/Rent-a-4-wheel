import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  email: z.string().trim().email("Enter a valid email."),
  phone: z.string().trim().optional(),
  message: z.string().trim().min(5, "Please include a short message."),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await prisma.contactMessage.create({
    data: { ...parsed.data, userId: session?.user?.id },
  });

  return NextResponse.json({ success: true });
}
