import { readiness } from "@/lib/readiness";
export async function GET(){const ready=await readiness();return Response.json({ready},{status:ready?200:503,headers:{"Cache-Control":"no-store"}});}
