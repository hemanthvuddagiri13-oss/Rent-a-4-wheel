import { auth } from "@/auth";
import { noticeTarget } from "@/lib/notice-center";
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
 const session = await auth(); if (!session?.user) return Response.json({ error: "Sign in." }, { status: 401 });
 try { return Response.redirect(new URL(await noticeTarget(session.user.id, (await context.params).id), req.url)); }
 catch { return Response.json({ error: "Not found." }, { status: 404 }); }
}
