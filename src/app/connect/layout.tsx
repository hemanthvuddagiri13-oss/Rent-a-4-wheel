import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
export default async function Layout({ children }: { children: React.ReactNode }) {
 const session = await auth(); if (!session?.user) redirect("/sign-in?callbackUrl=/connect");
 return <div className="min-w-0"><nav aria-label="Communications and support" className="mx-auto flex max-w-7xl flex-wrap gap-2 px-4 pt-6">{[["/connect", "Inbox"], ["/connect?view=notifications", "Notifications"], ["/connect?view=cases", "My cases"], ["/connect?view=reviews", "Reviews"], ["/connect?view=support", "Help & roadside"], ["/connect?view=operations", "Operations"]].map(([href,label])=><Link key={href} href={href} className="rounded-lg border border-white/15 px-4 py-3 text-sm hover:border-gold">{label}</Link>)}</nav>{children}</div>;
}
