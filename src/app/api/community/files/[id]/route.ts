import { auth } from "@/auth";
import { validateDeviceSession } from "@/lib/device-sessions";
import { readCollaborationFile } from "@/lib/collaboration-files";
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
 const session = await auth();
 if (!session?.user || !session.sessionId || typeof session.credentialVersion !== "number") return Response.json({ error: "Not found." }, { status: 404 });
 const { sessionId, credentialVersion } = session;
 const userId = session.user.id;
 try {
 if (!await validateDeviceSession(userId, sessionId, credentialVersion)) throw new Error("SESSION_UNAVAILABLE");
 const { id } = await context.params; const file = await readCollaborationFile(session.user.id, id);
 // The resource/storage checks above cannot authorize a revoked browser credential.
 if (!await validateDeviceSession(userId, sessionId, credentialVersion)) throw new Error("SESSION_UNAVAILABLE");
 return new Response(new Uint8Array(file.buffer), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" } });
 } catch { return Response.json({ error: "Not found." }, { status: 404 }); }
}
