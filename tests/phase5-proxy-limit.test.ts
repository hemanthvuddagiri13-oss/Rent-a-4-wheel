import {it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
vi.mock("next-auth",()=>({default:()=>({auth:(handler:unknown)=>handler})}));
import proxy from "@/proxy";
it("admits community multipart payloads above the JSON cap at the actual proxy boundary",async()=>{
 const form=new FormData();form.set("file",new Blob([new Uint8Array(50000)],{type:"image/png"}),"fixture.png");
 const response=await (proxy as unknown as (r:NextRequest)=>Promise<Response>)(new NextRequest("http://localhost:3000/api/community",{method:"POST",body:form}));
 expect(response.status).toBe(200);
});
