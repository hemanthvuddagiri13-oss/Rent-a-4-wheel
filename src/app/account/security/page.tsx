import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SecurityPanel } from "@/components/account/security-panel";
import { listDeviceSessions } from "@/lib/device-sessions";
export default async function SecurityPage(){const session=await auth();if(!session?.user)redirect("/sign-in");const rows=await listDeviceSessions(session.user.id);return <main className="mx-auto max-w-3xl space-y-6 p-6"><h1 className="text-3xl font-semibold">Account security</h1><SecurityPanel initial={rows.map(r=>({...r,lastSeenAt:r.lastSeenAt.toISOString(),expires:r.expires.toISOString(),current:r.id===session.sessionId}))}/></main>;}
