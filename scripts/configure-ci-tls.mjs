// Disposable GitHub Actions PostgreSQL service only. Never run against deployment infrastructure.
import {execFileSync} from "node:child_process";
import {mkdtempSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
if(process.env.GITHUB_ACTIONS!=="true"||!process.env.CI_POSTGRES_CONTAINER||!process.env.GITHUB_ENV)throw new Error("Disposable CI service required");
const directory=mkdtempSync(path.join(tmpdir(),"r4w-ci-tls-")),cert=path.join(directory,"server.crt"),key=path.join(directory,"server.key"),container=process.env.CI_POSTGRES_CONTAINER;
const run=(command,args)=>execFileSync(command,args,{stdio:"pipe"});
run("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-keyout",key,"-out",cert,"-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"]);
run("docker",["cp",cert,`${container}:/var/lib/postgresql/server.crt`]);
run("docker",["cp",key,`${container}:/var/lib/postgresql/server.key`]);
run("docker",["exec","-u","root",container,"chown","postgres:postgres","/var/lib/postgresql/server.crt","/var/lib/postgresql/server.key"]);
run("docker",["exec","-u","root",container,"chmod","600","/var/lib/postgresql/server.key"]);
for(const statement of ["ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'","ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'","ALTER SYSTEM SET ssl='on'","SELECT pg_reload_conf()"])
 run("docker",["exec","-u","postgres",container,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-c",statement]);
appendFileSync(process.env.GITHUB_ENV,`CI_TLS_CERT=${cert}\nCI_TLS_KEY=${key}\n`);
console.log("Disposable PostgreSQL TLS and loopback HTTPS fixture certificates configured.");
