import { auth } from "@/auth";
import { noticeTarget } from "@/lib/notice-center";
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
 const session = await auth(); if (!session?.user) return Response.json({ error: "Sign in." }, { status: 401 });
 try { const target=await noticeTarget(session.user.id,(await context.params).id);return new Response(null,{status:303,headers:{Location:target,"Cache-Control":"private, no-store"}}); }
 catch { return Response.json({ error: "Not found." }, { status: 404 }); }
}
