import { boundedBody } from "@/lib/bounded-request";
import { verifyTwilioSignature,handleSmsConsent } from "@/lib/notice-channels";
export async function POST(req:Request){
 const token=process.env.TWILIO_AUTH_TOKEN,url=process.env.TWILIO_INBOUND_URL;
 if(!token||!url)return new Response("Unavailable",{status:503});
 if(!req.headers.get("content-type")?.includes("application/x-www-form-urlencoded"))return new Response("Unsupported",{status:415});
 let raw:string;try{raw=(await boundedBody(req,16000)).toString("utf8");}catch{return new Response("Invalid body",{status:413});}const params=new URLSearchParams(raw);
 if(!verifyTwilioSignature(url,params,req.headers.get("x-twilio-signature")??"",token))return new Response("Unauthorized",{status:403});
 await handleSmsConsent(params);return new Response("<Response></Response>",{headers:{"Content-Type":"text/xml"}});
}
