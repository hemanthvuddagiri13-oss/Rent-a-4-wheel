import React from "react";
export function useSearchParams(){return new URLSearchParams(window.location.search)}
export function useRouter(){return {refresh(){},push(url:string){window.location.assign(url)}}}
const session={status:"authenticated",data:{user:{id:"browser-owner",name:"Test Customer",email:"fixture@example.com"}}};
export function useSession(){return session}
export async function signIn(){return {ok:true}}
export default function NextElement({href,src,alt,children,...props}:{href?:string;src?:string;alt?:string;children?:React.ReactNode;[key:string]:unknown}){
 // Browser fixture replaces Next's image optimizer; production still uses Image.
 // eslint-disable-next-line @next/next/no-img-element
 if(src)return <img src={src} alt={alt??""}/>;
 return <a href={href} className={props.className as string}>{children}</a>;
}
