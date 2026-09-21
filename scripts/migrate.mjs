import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

export function migrationEnvironment(env){
 const deployed=["preview","staging","production"].includes(env.APP_ENV);
 if(!env.DIRECT_DATABASE_URL)throw new Error("DIRECT_MIGRATION_ENDPOINT_REQUIRED");
 let endpoint;try{endpoint=new URL(env.DIRECT_DATABASE_URL);}catch{throw new Error("INVALID_DIRECT_MIGRATION_ENDPOINT");}
 if(!["postgres:","postgresql:"].includes(endpoint.protocol)||!endpoint.hostname||!endpoint.pathname||endpoint.searchParams.get("pgbouncer")==="true"||/pooler|pool\./i.test(endpoint.hostname)||endpoint.port==="6543"||["transaction","statement"].includes(endpoint.searchParams.get("pool_mode"))||env.MIGRATION_CONNECTION_MODE&&env.MIGRATION_CONNECTION_MODE!=="direct"||deployed&&env.MIGRATION_CONNECTION_MODE!=="direct")throw new Error("UNSAFE_MIGRATION_CONNECTION");
 return {...env,DATABASE_URL:env.DIRECT_DATABASE_URL,DIRECT_DATABASE_URL:env.DIRECT_DATABASE_URL};
}

export async function migrate(args,env=process.env){
 if(!["deploy","status","resolve"].includes(args[0])||args.some(a=>a==="--url"||a.startsWith("--url=")))throw new Error("INVALID_MIGRATION_COMMAND");
 const selected=migrationEnvironment(env);
 const cli=fileURLToPath(new URL("../node_modules/prisma/build/index.js",import.meta.url));
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,"migrate",...args],{env:selected,stdio:["ignore","pipe","pipe"],windowsHide:true});
  let output="",error="";
  const keep=(value,chunk)=>{const next=value+chunk.toString();if(next.length>1024*1024){child.kill();return next.slice(0,1024*1024);}return next;};
  child.stdout.on("data",c=>{output=keep(output,c);});child.stderr.on("data",c=>{error=keep(error,c);});
  child.on("error",()=>reject(new Error("MIGRATION_PROCESS_UNAVAILABLE")));
  child.on("exit",code=>{
   if(code===0){console.log(output.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi,"[database endpoint]"));resolve(0);}
   else {const prismaCode=error.match(/\bP\d{4}\b/)?.[0]??"PROCESS_FAILED";console.error("Migration failed: "+prismaCode+". Inspect database migration records using the direct operator connection; credentials are not logged.");resolve(code??1);}
  });
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await migrate(process.argv.slice(2));}catch(error){console.error(error instanceof Error?error.message:"MIGRATION_REFUSED");process.exitCode=1;}
}
