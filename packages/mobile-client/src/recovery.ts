/** The adapter must be confidential, device-local storage. Never use AsyncStorage. */
export interface RecoveryStore { read(scope: string): Promise<string | null>; write(scope: string, value: string): Promise<void> }
export type RecoveryRecord = { key: string; operation: string; input: unknown; createdAt: string };
export class RecoveryConflict extends Error { constructor() { super('An earlier request needs recovery before changing this action.'); } }

/** Persist before dispatch. A failed/uncertain response never removes intent.
 * Each process owns one coordinator; process death discards locks, not records.
 * Authorization is deliberately delegated to dispatch on EVERY replay. */
export class RecoveryJournal {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private store: RecoveryStore) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next; }
  private async load(scope: string): Promise<RecoveryRecord[]> {
    const raw = await this.store.read(scope); if (raw === null) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.some(r => !r || typeof r.key !== 'string' || typeof r.operation !== 'string' || typeof r.createdAt !== 'string' || !('input' in r))) throw new Error('Secure recovery data is unavailable. No request was sent.');
    return data;
  }
  list(scope: string) { return this.serial(() => this.load(scope)); }
  execute<T>(scope: string, record: RecoveryRecord, dispatch: (frozen: RecoveryRecord) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const records = await this.load(scope);
      const existing = records.find(r => r.key === record.key);
      // Do not manufacture a new intent by editing an uncertain request. The
      // user must recover it first; otherwise version refresh could duplicate it.
      if (!existing && records.some(r => r.operation === record.operation && JSON.stringify((r.input as { params?: unknown })?.params) === JSON.stringify((record.input as { params?: unknown })?.params))) throw new RecoveryConflict();
      if (existing && (existing.operation !== record.operation || JSON.stringify(existing.input) !== JSON.stringify(record.input))) throw new RecoveryConflict();
      const frozen = existing ?? JSON.parse(JSON.stringify(record)) as RecoveryRecord;
      if (!existing) { if (records.length >= 50) throw new Error('Recover pending requests before submitting more.'); records.push(frozen); await this.store.write(scope, JSON.stringify(records)); }
      const result = await dispatch(JSON.parse(JSON.stringify(frozen)) as RecoveryRecord);
      // If acknowledgement persistence fails, preserve the key and replay it.
      await this.store.write(scope, JSON.stringify(records.filter(r => r.key !== frozen.key)));
      return result;
    });
  }
}
