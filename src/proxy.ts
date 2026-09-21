import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { canAccessAdmin } from "@/lib/rbac";
import { localDevelopment } from "@/lib/deployment-environment";
import { productionConfiguration } from "@/lib/production-config";
import { newRequestId, requestOriginAllowed, sharedRequestLimit } from "@/lib/security-request";

const { auth } = NextAuth(authConfig);

export default auth(async (req) => {
  const { pathname } = req.nextUrl;
  const deployed = !localDevelopment(), requestId = newRequestId();
  const reject = (status: number, error: string, extra: Record<string,string> = {}) => NextResponse.json({error,requestId},{status,headers:{...extra,"Cache-Control":"private, no-store","x-request-id":requestId,"Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'",...(deployed?{"Strict-Transport-Security":"max-age=31536000; includeSubDomains"}:{})}});
  const health = pathname === "/api/health/live" || pathname === "/api/health/ready";
  if (deployed && !health && !productionConfiguration().ready) return reject(503,"Service configuration unavailable");
  if (pathname.startsWith("/api/") && !health) {
    const machine = pathname === "/api/webhooks/stripe" || pathname === "/api/community/sms" || pathname.startsWith("/api/cron/");
    if (!["GET","HEAD","OPTIONS"].includes(req.method) && !machine && !requestOriginAllowed(req)) return reject(403,"Invalid request origin");
    const upload = /\/files$|\/upload$|\/condition-reports$/.test(pathname), limit = upload ? 9*1024*1024 : machine ? 1024*1024 : 24000;
    if (req.body) {
      const reader=req.clone().body!.getReader();let length=0;
      try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>limit){void reader.cancel();return reject(413,"Request too large");}}}finally{reader.releaseLock();}
    }
    if(deployed&&!machine){try{if(!await sharedRequestLimit(req.headers,pathname.startsWith("/api/auth/")?"auth":"api",pathname.startsWith("/api/auth/")?30:120))return reject(429,"Too many requests",{"Retry-After":"60"});}catch{return reject(503,"Service temporarily unavailable");}}
  }
  const isAdminRoute = pathname.startsWith("/admin");
  const isAccountRoute = pathname.startsWith("/account");

  if (!req.auth && (isAdminRoute || isAccountRoute)) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  if (isAdminRoute && req.auth && !canAccessAdmin(req.auth.user?.role)) {
    return NextResponse.redirect(new URL("/account", req.nextUrl.origin));
  }

  const nonce=Buffer.from(crypto.randomUUID()).toString("base64");
  const csp=`default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${deployed?"":" 'unsafe-eval'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://res.cloudinary.com; font-src 'self'; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'${deployed?"; upgrade-insecure-requests":""}`;
  const headers=new Headers(req.headers);headers.set("x-request-id",requestId);headers.set("x-nonce",nonce);headers.set("Content-Security-Policy",csp);
  const response=NextResponse.next({request:{headers}});response.headers.set("x-request-id",requestId);response.headers.set("Content-Security-Policy",csp);
  if(pathname.startsWith("/api/")||isAccountRoute||isAdminRoute)response.headers.set("Cache-Control","private, no-store");
  if(deployed)response.headers.set("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  return response;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
