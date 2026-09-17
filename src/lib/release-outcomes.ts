import { AsyncLocalStorage } from "node:async_hooks";

export type ReleaseOutcome = { operationId: string; status: "processed" | "failed" | "quarantined" | "uncertain" };
// Request-local reporting only. Execution exclusion is entirely in PostgreSQL.
const outcomes = new AsyncLocalStorage<Map<string, ReleaseOutcome>>();
export function recordRelease(outcome: ReleaseOutcome) {
  outcomes.getStore()?.set(outcome.operationId, outcome);
  return outcome;
}
export async function collectReleases<T>(run: () => Promise<T>) {
  const collected = outcomes.getStore() ?? new Map<string, ReleaseOutcome>();
  const result = await outcomes.run(collected, run);
  const releaseOperations = [...collected.values()];
  const releases = { processed: 0, failed: 0, quarantined: 0, uncertain: 0 };
  for (const outcome of releaseOperations) releases[outcome.status]++;
  return { result, releases, releaseOperations };
}
