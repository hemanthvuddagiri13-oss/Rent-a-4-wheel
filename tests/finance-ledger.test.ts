import { afterAll,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { journal,reverseJournal } from "@/lib/finance-ledger";
import { csvCell } from "@/lib/finance-access";
import { roundBps } from "@/lib/finance-rules";
import { barrier } from "./helpers/barrier";

// Journals deliberately survive the test transaction: their database-enforced
// immutability is the assertion. CI destroys the disposable database afterwards.
const one=new PrismaClient(),two=new PrismaClient(),observer=new PrismaClient();
afterAll(async()=>{await Promise.all([one.$disconnect(),two.$disconnect(),observer.$disconnect()]);});
const posting=(key=randomUUID())=>({key,kind:"TEST_LEDGER",currency:"usd",description:"Finance invariant fixture",lines:[{account:"TEST_CASH",debitCents:101},{account:"TEST_LIABILITY",creditCents:101}]});
it("rejects unbalanced raw SQL at commit, not only through the service validator",async()=>{
 const id=randomUUID();await expect(one.$transaction(async tx=>{
  await tx.ledgerJournal.create({data:{id,key:id,kind:"TEST",currency:"usd",description:"Invalid raw fixture",fingerprint:id}});
  await tx.ledgerLine.createMany({data:[{journalId:id,account:"CASH",debitCents:100},{journalId:id,account:"PAYABLE",creditCents:99}]});
 })).rejects.toThrow("balance");expect(await one.ledgerJournal.findUnique({where:{id}})).toBeNull();
});
it("enforces immutable headers, entries and append protection, then records an exact reversal",async()=>{
 const input=posting(),original=await one.$transaction(tx=>journal(tx,input));
 await expect(one.ledgerJournal.update({where:{id:original.id},data:{description:"Rewrite"}})).rejects.toThrow("Immutable");
 const line=await one.ledgerLine.findFirstOrThrow({where:{journalId:original.id}});
 await expect(one.ledgerLine.delete({where:{id:line.id}})).rejects.toThrow("Immutable");
 await expect(one.$transaction(tx=>tx.ledgerLine.createMany({data:[{journalId:original.id,account:"CASH",debitCents:5},{journalId:original.id,account:"PAYABLE",creditCents:5}]}))).rejects.toThrow("append");
 const reversal=await one.$transaction(tx=>reverseJournal(tx,original.id,randomUUID(),"Reverse the exact immutable fixture"));
 const entries=await one.ledgerLine.findMany({where:{journalId:{in:[original.id,reversal.id]}}});
 for(const account of new Set(entries.map(l=>l.account)))expect(entries.filter(l=>l.account===account).reduce((s,l)=>s+l.debitCents-l.creditCents,0)).toBe(0);
 await expect(one.$transaction(tx=>reverseJournal(tx,original.id,randomUUID(),"Duplicate recovery"))).rejects.toThrow();
});
it("concurrent independent PostgreSQL sessions commit one journal for an immutable key",async()=>{
 const input=posting(),entered=barrier(),release=barrier();let firstPid=0,secondPid=0;
 const first=one.$transaction(async tx=>{firstPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;const result=await journal(tx,input);entered.release();await release.wait;return result;},{timeout:15000});
 await entered.wait;
 const second=two.$transaction(async tx=>{secondPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;return journal(tx,input);},{timeout:15000});
 let blocked=false;
 try{for(let n=0;n<300;n++){const rows=await observer.$queryRaw<Array<{waiting:boolean}>>`SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=${secondPid}`;if(rows[0]?.waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);expect(firstPid).not.toBe(secondPid);}finally{release.release();}
 const [a,b]=await Promise.all([first,second]);expect(a.id).toBe(b.id);expect(await one.ledgerJournal.count({where:{key:input.key}})).toBe(1);expect(await one.ledgerLine.count({where:{journalId:a.id}})).toBe(2);
 await expect(one.$transaction(tx=>journal(tx,{...input,description:"Changed intent"}))).rejects.toThrow("idempotency mismatch");
});
it.each(["=SUM(A1:A9)"," +1","-2","@cmd","\tformula","\rformula"])("neutralizes CSV formula prefix %j",value=>{expect(csvCell(value)).toBe('"\''+value+'"');});
it("rounds monetary basis points with integer half-up arithmetic",()=>{expect(roundBps(1,5000)).toBe(1);expect(roundBps(101,1500)).toBe(15);expect(roundBps(100000000,9999)).toBe(99990000);expect(csvCell('normal "text"')).toBe('"normal ""text"""');});
