import {execFileSync} from "node:child_process";
import {readFileSync,readdirSync,existsSync} from "node:fs";
import path from "node:path";
const baseline="c68b12200a36bd3e45f94292047dc03538908a29";
const git=(...args)=>execFileSync("git",args,{encoding:"utf8"}).trim();
const failures=[];
if(process.argv.includes("--client")){
 const secretNames=["AUTH_SECRET","CRON_SECRET","STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","RESEND_API_KEY","PRIVATE_STORAGE_SECRET_ACCESS_KEY","MONITORING_ALERT_SECRET","TWILIO_AUTH_TOKEN","CLOUDINARY_API_SECRET","DATABASE_URL","DIRECT_DATABASE_URL"];
 const values=secretNames.map(name=>process.env[name]).filter(v=>v&&v.length>=8);
 function inspect(dir){for(const file of readdirSync(dir,{withFileTypes:true})){const target=path.join(dir,file.name);if(file.isDirectory())inspect(target);else{const content=readFileSync(target,"utf8");if(values.some(value=>content.includes(value)))failures.push("Server secret in client artifact: "+target);}}}
 if(!existsSync(".next/static"))failures.push("Production client artifacts missing");else inspect(".next/static");
}else{
 const migrations=git("ls-tree","-r","--name-only",baseline,"--","prisma/migrations").split("\n").filter(Boolean);
 for(const file of migrations){if(!existsSync(file)||git("hash-object",file)!==git("rev-parse",baseline+":"+file))failures.push("Approved migration changed: "+file);}
 const files=git("ls-files","-z").split("\0").filter(Boolean);
 const forbidden=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,/\bAKIA[A-Z0-9]{16}\b/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/];
 for(const file of files){if(!existsSync(file))continue;const bytes=readFileSync(file);if(bytes.includes(0))continue;const content=bytes.toString("utf8");if(forbidden.some(pattern=>pattern.test(content)))failures.push("Possible committed credential: "+file);if(/^(\.env(?:\..*)?|private-storage\/|\.next[^/]*\/|tests\/artifacts\/)/.test(file)&&file!==".env.example")failures.push("Generated or private artifact tracked: "+file);}
 console.log(`Checked ${migrations.length} approved migration files and ${files.length} tracked files. Credential values are never printed.`);
}
if(failures.length){for(const failure of failures)console.error(failure);process.exitCode=1;}else console.log("Release integrity checks passed.");
