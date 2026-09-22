"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
export function HoldNotice({expiresAt,checkoutComplete}:{expiresAt:string;checkoutComplete:boolean}) {
 const [remaining,setRemaining]=useState<number|null>(null);
 useEffect(()=>{const tick=()=>setRemaining(Math.max(0,Math.ceil((Date.parse(expiresAt)-Date.now())/1000)));tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[expiresAt]);
 if(remaining===null)return null;
 return <aside aria-label="Checkout hold" className="my-5 rounded-xl border border-white/20 bg-card p-4 text-sm"><p role={remaining===0?"alert":undefined}>{remaining===0?"Your checkout hold has ended. Availability must be checked again.":"Estimated time remaining on your current hold:"} {remaining>0&&<span role="timer" aria-live="off" className="font-semibold tabular-nums">{Math.floor(remaining/60)}:{String(remaining%60).padStart(2,"0")}</span>}</p><p className="mt-2 text-muted">The server checks availability and payment status before completing a booking.</p>{remaining===0&&<div className="mt-2 flex flex-wrap gap-4"><Link className="inline-flex min-h-11 items-center underline" href="/account">Check your reservation status</Link>{!checkoutComplete&&<Link className="inline-flex min-h-11 items-center underline" href="/vehicles">Choose available dates</Link>}</div>}{remaining===0&&checkoutComplete&&<p className="text-muted">Check your existing reservation before starting another checkout. A payment may still be processing.</p>}</aside>;
}
