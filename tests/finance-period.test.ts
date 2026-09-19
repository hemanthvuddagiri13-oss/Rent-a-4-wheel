import { expect,it } from "vitest";
import { financePeriod } from "@/lib/finance-documents";
import { nextPayoutCutoff } from "@/lib/payout-workers";
it("monthly Chicago reporting uses local midnight across daylight saving",()=>{expect(financePeriod("2026-03","MONTHLY_SUMMARY","America/Chicago")).toEqual({start:new Date("2026-03-01T06:00:00Z"),end:new Date("2026-04-01T05:00:00Z")});});
it("yearly reporting and invalid month inputs use strict period boundaries",()=>{expect(financePeriod("2026","YEARLY_SUMMARY","America/Chicago").end).toEqual(new Date("2027-01-01T06:00:00Z"));expect(()=>financePeriod("2026-13","MONTHLY_SUMMARY","America/Chicago")).toThrow();expect(()=>financePeriod("2026","MONTHLY_SUMMARY","America/Chicago")).toThrow();expect(()=>financePeriod("2026-01","YEARLY_SUMMARY","America/Chicago")).toThrow();});
it("weekly payout cutoff follows the local clock across spring DST",()=>{expect(nextPayoutCutoff("WEEKLY","America/Chicago",new Date("2026-03-07T15:00:00Z"))).toEqual(new Date("2026-03-09T14:00:00Z"));});
