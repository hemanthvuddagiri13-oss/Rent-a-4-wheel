"use client";
import { Button } from "@/components/ui/button";
import {useState} from "react";
export function AdminMutationFields(){
 const [message,setMessage]=useState("");
 async function requestCode(){const r=await fetch("/api/admin/operations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"stepUp"})});setMessage(r.ok?"Check your email for a fresh security code.":"Unable to request a code. Check your session and try again.");}
 return <fieldset className="space-y-3"><legend>Authorize this change</legend><Button variant="secondary" type="button" onClick={requestCode}>Email security code</Button><label className="block">Security code<input name="code" required pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="workspace-input max-w-sm"/></label><label className="block">Reason<input name="reason" required minLength={10} maxLength={500} className="workspace-input"/></label><label className="flex min-h-11 items-center gap-3"><input name="confirm" type="checkbox" value="true" required/> I confirm this administrative change.</label><p role="status">{message}</p></fieldset>;
}
