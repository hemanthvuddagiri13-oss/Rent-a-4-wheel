"use client";
import {useEffect} from "react";
import {useRouter} from "next/navigation";
export function ConversationLive({id,messageId}:{id:string;messageId?:string}) {
 const router=useRouter();
 useEffect(()=>{
  const refresh=()=>{if(document.visibilityState!=="visible")return;if(messageId)void fetch("/api/community",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"message",command:"read",id,messageId})}).catch(()=>{});if(!["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName??""))router.refresh();};
  const timer=setInterval(refresh,15000);return()=>clearInterval(timer);
 },[id,messageId,router]);
 return <p className="text-xs text-silver">Updates automatically while this conversation is visible.</p>;
}
