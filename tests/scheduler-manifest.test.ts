import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {WORKER_STALENESS_MINUTES} from "@/lib/worker-schedule";
// Exercise the production dispatcher without sending credentials to a provider.
import {dispatchCron,scheduledPaths} from "../scripts/dispatch-cron.mjs";
it("schedules every monitored worker and the monitor without duplicates",()=>{
 const expected=[...Object.keys(WORKER_STALENESS_MINUTES),"operations/monitor"].map(name=>"/api/cron/"+name).sort();
 expect([...scheduledPaths].sort()).toEqual(expected);expect(new Set(scheduledPaths).size).toBe(expected.length);
 const cron=readFileSync("deploy/r4w.cron","utf8");expect(cron).not.toContain("\r");for(const worker of expected)expect(cron).toContain("dispatch-cron.mjs "+worker.slice("/api/cron/".length));
});
it("uses a header-only secret, refuses redirects and reports failed invocations",async()=>{
 const env:NodeJS.ProcessEnv={NODE_ENV:"test",SITE_URL:"https://isolated.invalid",CRON_SECRET:"synthetic".repeat(8)};let calls=0;
 const request:typeof fetch=async(url,options)=>{calls++;expect(url.toString()).toBe("https://isolated.invalid/api/cron/operations/scan");expect(options?.redirect).toBe("error");expect(options?.headers).toEqual({authorization:"Bearer "+env.CRON_SECRET});expect(options?.method).toBe("POST");return new Response("private failure body",{status:503});};
 await expect(dispatchCron("operations/scan",env,request)).rejects.toThrow("CRON_HTTP_503");expect(calls).toBe(1);
 await expect(dispatchCron("unknown",env,request)).rejects.toThrow("UNKNOWN_SCHEDULE");
 await expect(dispatchCron("operations/scan",{...env,SITE_URL:"http://isolated.invalid"},request)).rejects.toThrow("INVALID_SCHEDULER_ORIGIN");expect(calls).toBe(1);
});
