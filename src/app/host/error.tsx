"use client";
import Link from "next/link";
export default function HostError({ reset }: { reset: () => void }) {
  return <div className="mx-auto max-w-2xl space-y-5 px-4 py-12"><h1 className="text-2xl text-white">This workspace is unavailable</h1><p className="text-silver">Your account may not have permission for this workspace, or the service could not load it. Return to the host overview to check your application and access.</p><div className="flex flex-wrap gap-4"><Link className="text-gold-bright underline" href="/host">Host overview</Link><button className="text-gold-bright underline" onClick={reset}>Try again</button></div></div>;
}
