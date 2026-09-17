import { auth } from "@/auth";
import { readCollaborationFile } from "@/lib/collaboration-files";
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
 const session = await auth();
 if (!session?.user) return Response.json({ error: "Not found." }, { status: 404 });
 try { const { id } = await context.params; const file = await readCollaborationFile(session.user.id, id);
 return new Response(new Uint8Array(file.buffer), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" } });
 } catch { return Response.json({ error: "Not found." }, { status: 404 }); }
}
