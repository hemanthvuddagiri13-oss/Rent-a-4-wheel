import type {Instrumentation} from "next";

export const onRequestError:Instrumentation.onRequestError=async (_error,request)=>{
 // Never serialize errors, paths, request objects, headers or render context.
 // Next's request path can contain personal data and authentication query values.
 if(process.env.NEXT_RUNTIME==="nodejs"){
  const {reportOperationalEvent}=await import("@/lib/observability");
  const id=request.headers["x-request-id"];
  await reportOperationalEvent("APPLICATION_FAILED","CRITICAL",typeof id==="string"?id:undefined);
 }
};
