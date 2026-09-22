"use client";
import { Button } from "@/components/ui/button";
import {useState} from "react";
export function JurisdictionPanel({states}:{states:Array<{code:string;mode:string;version:number;readyGates:number}>}){
 const [state,setState]=useState("TX"),[code,setCode]=useState(""),[reason,setReason]=useState(""),[message,setMessage]=useState("");
 async function send(mode?:"DISABLED"|"STAGING"){
  const response=await fetch("/api/admin/operations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(mode?{action:"jurisdictionMode",jurisdictionCode:state,mode,code,reason}:{action:"stepUp"})});
  setMessage(response.ok?(mode?"Saved. Refresh to see current release status.":"Security code requested."):"Change refused. Check your access and request a fresh code.");if(response.ok)setCode("");
 }
 return <section className="space-y-4"><h2 className="text-xl font-semibold">State release controls</h2><p>Every state starts disabled. Staging requires all twelve current approval gates. No state is approved for production. Disabling a state preserves refunds, returns, claims and financial recovery.</p><label className="block">Operating state<select value={state} onChange={e=>setState(e.target.value)} className="workspace-input">{states.map(s=><option key={s.code} value={s.code}>{s.code}: {s.mode} — {s.readyGates}/12 staging gates</option>)}</select></label><Button variant="secondary" onClick={()=>send()}>Email state-change security code</Button><label className="block">State-change security code<input value={code} onChange={e=>setCode(e.target.value)} className="workspace-input" autoComplete="one-time-code" maxLength={6}/></label><label className="block">State-change reason<input value={reason} onChange={e=>setReason(e.target.value)} className="workspace-input" maxLength={500}/></label><div className="flex flex-wrap gap-3"><Button variant="secondary" onClick={()=>send("DISABLED")}>Disable state</Button><Button variant="secondary" onClick={()=>send("STAGING")}>Configure staging</Button></div><p role="status">{message}</p></section>;
}
