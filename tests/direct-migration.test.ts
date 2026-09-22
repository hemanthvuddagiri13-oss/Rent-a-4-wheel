import {it,expect} from "vitest";
import {PrismaClient} from "@prisma/client";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";

it("the deployment command uses the direct endpoint and migration role, never the runtime endpoint and role",async()=>{
 const source=new URL(process.env.DATABASE_URL!);if(!source.pathname.endsWith("_test"))throw new Error("Disposable database required");
 const adminUrl=new URL(source);adminUrl.pathname="/postgres";
 const db=new PrismaClient({datasources:{db:{url:adminUrl.toString()}}});
 const suffix=randomUUID().replaceAll("-","").slice(0,12),name="direct_migration_"+suffix,role="migration_"+suffix,runtimeRole="runtime_"+suffix;
 const direct=new URL(source);direct.pathname="/"+name;direct.username=role;direct.password="synthetic_migration_fixture";
 const runtime=new URL(source);runtime.pathname="/postgres";runtime.username=runtimeRole;runtime.password="synthetic_runtime_fixture";runtime.searchParams.set("pgbouncer","true");
 try{
  await db.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic_migration_fixture'`);
  await db.$executeRawUnsafe(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'synthetic_runtime_fixture'`);
  await db.$executeRawUnsafe(`CREATE DATABASE "${name}" OWNER "${role}"`);
  const result=spawnSync(process.execPath,["scripts/migrate.mjs","deploy"],{env:{...process.env,APP_ENV:"staging",MIGRATION_CONNECTION_MODE:"direct",DATABASE_URL:runtime.toString(),DIRECT_DATABASE_URL:direct.toString()},encoding:"utf8",timeout:90000});
  expect(result.status,"Migration must succeed through the direct owner role").toBe(0);
  const verify=new PrismaClient({datasources:{db:{url:direct.toString()}}});
  try{expect((await verify.$queryRaw<Array<{owner:string}>>`SELECT tableowner AS owner FROM pg_tables WHERE tablename='Reservation'`)[0]?.owner).toBe(role);}
  finally{await verify.$disconnect();}
 }finally{
  await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${runtimeRole}"`);await db.$disconnect();
 }
},120000);

it.each([
 {DIRECT_DATABASE_URL:""},
 {DIRECT_DATABASE_URL:"postgresql://synthetic:secret@pool.example.invalid:5432/app"},
 {DIRECT_DATABASE_URL:"postgresql://synthetic:secret@localhost:6543/app"},
 {DIRECT_DATABASE_URL:"postgresql://synthetic:secret@localhost:5432/app?pgbouncer=true"},
 {DIRECT_DATABASE_URL:"postgresql://synthetic:secret@localhost:5432/app?pool_mode=transaction"},
 {MIGRATION_CONNECTION_MODE:"transaction"},
 {MIGRATION_CONNECTION_MODE:""},
])("deployment CLI refuses unsafe direct configuration without printing credentials (%j)",overrides=>{
 const result=spawnSync(process.execPath,["scripts/migrate.mjs","deploy"],{env:{...process.env,APP_ENV:"production",MIGRATION_CONNECTION_MODE:"direct",DIRECT_DATABASE_URL:"postgresql://synthetic:secret@localhost:5432/app",...overrides},encoding:"utf8",timeout:10000});
 expect(result.status).toBe(1);expect(result.stderr).toMatch(/DIRECT_MIGRATION_ENDPOINT_REQUIRED|UNSAFE_MIGRATION_CONNECTION/);expect(result.stderr+result.stdout).not.toMatch(/synthetic|secret|postgresql:\/\//);
});
