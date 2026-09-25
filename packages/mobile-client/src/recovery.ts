import { MobileApiError } from './index';
/** The adapter must be confidential, device-local storage. Never use AsyncStorage. */
export interface RecoveryStore { read(scope: string): Promise<string | null>; write(scope: string, value: string): Promise<void>; rewriteKnown?(protect: (value: string) => Promise<string>): Promise<void> }
export type RecoveryRecord = { key: string; operation: string; input: unknown; createdAt: string; inputHash?: string; scopeHash?: string; redacted?: boolean; intentStorageKey?: string };
export class RecoveryConflict extends Error { constructor() { super('An earlier request needs recovery before changing this action.'); } }
export class IntentKeys {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private storage: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }, private random: () => string) {}
  private serial<T>(work: () => Promise<T>) { const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next; }
  get(key: string) { return this.serial(async () => { const prior = await this.storage.get(key); if (prior) return prior; const value = this.random(); await this.storage.set(key, value); return value; }); }
  acknowledge(key: string, value: string) { return this.serial(async () => { if (await this.storage.get(key) === value) await this.storage.remove(key); }); }
}

/** Persist before dispatch. Ambiguous responses preserve immutable request identity.
 * Only a committed acknowledgement or durable key-bound non-commit proof releases
 * an intent. HTTP status alone is never proof about an earlier delivery.
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
    record = JSON.parse(JSON.stringify(record)) as RecoveryRecord;
    return this.serial(async () => {
      const records = await this.load(scope);
      const existing = records.find(r => r.key === record.key);
      // Do not manufacture a new intent by editing an uncertain request. The
      // user must recover it first; otherwise version refresh could duplicate it.
      if (!existing && records.some(r => r.operation === record.operation && (r.scopeHash && record.scopeHash ? r.scopeHash === record.scopeHash : JSON.stringify((r.input as { params?: unknown })?.params) === JSON.stringify((record.input as { params?: unknown })?.params)))) throw new RecoveryConflict();
      if (existing && (existing.operation !== record.operation || (existing.inputHash && record.inputHash ? existing.inputHash !== record.inputHash : JSON.stringify(existing.input) !== JSON.stringify(record.input)))) throw new RecoveryConflict();
      // Re-entering the exact original request may supply its transient body;
      // persisted hashes prevent editing it into a different mutation.
      const frozen = existing?.redacted ? { ...record, key: existing.key, createdAt: existing.createdAt } : existing ?? JSON.parse(JSON.stringify(record)) as RecoveryRecord;
      if (!existing) { if (records.length >= 50) throw new Error('Recover pending requests before submitting more.'); records.push(frozen); await this.store.write(scope, JSON.stringify(records)); }
      let result: T;
      try { result = await dispatch(JSON.parse(JSON.stringify(frozen)) as RecoveryRecord); }
      catch (error) {
        // The server has permanently fenced this key as non-committed. Persist
        // removal before exposing the rejection to an editable screen. A storage
        // failure leaves the original intent recoverable after restart.
        if (error instanceof MobileApiError && error.nonCommitKey === frozen.key) await this.store.write(scope, JSON.stringify(records.filter(r => r.key !== frozen.key)));
        throw error;
      }
      // If acknowledgement persistence fails, preserve the key and replay it.
      await this.store.write(scope, JSON.stringify(records.filter(r => r.key !== frozen.key)));
      return result;
    });
  }
}
