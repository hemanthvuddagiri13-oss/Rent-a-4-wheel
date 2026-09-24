import { expect, it, vi } from 'vitest';
import { RecoveryJournal, type RecoveryRecord, type RecoveryStore } from '../packages/mobile-client/src/recovery';
const request = (): RecoveryRecord => ({ key: 'original-request-key', operation: 'replyCase', input: { params: { id: 'case-one' }, body: { body: 'Synthetic reply', version: 3 } }, createdAt: '2026-09-24T00:00:00Z' });
function fixture() { const values = new Map<string, string>(); const store: RecoveryStore = { read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); } }; return { values, store, journal: new RecoveryJournal(store) }; }
it('persists intent before dispatch and replays exact version/key after process replacement', async () => {
  const { store, journal } = fixture(), receipts = new Set<string>(); let mutations = 0;
  await expect(journal.execute('owner', request(), async r => { expect(await store.read('owner')).toContain(r.key); receipts.add(r.key); mutations++; throw new Error('response lost after commit'); })).rejects.toThrow('response lost');
  const restarted = new RecoveryJournal(store), records = await restarted.list('owner'); expect(records).toEqual([request()]);
  await restarted.execute('owner', records[0], async r => { expect(r).toEqual(request()); if (!receipts.has(r.key)) mutations++; });
  expect(mutations).toBe(1); expect(await restarted.list('owner')).toEqual([]);
});
it('does not dispatch if secure persistence fails', async () => {
  const dispatch = vi.fn(), journal = new RecoveryJournal({ read: async () => null, write: async () => { throw new Error('locked'); } });
  await expect(journal.execute('owner', request(), dispatch)).rejects.toThrow('locked'); expect(dispatch).not.toHaveBeenCalled();
});
it('acknowledgement storage loss preserves the original request for replay', async () => {
  const { store, values } = fixture(); let writes = 0;
  const journal = new RecoveryJournal({ ...store, write: async (key, value) => { if (++writes === 2) throw new Error('process terminated'); values.set(key, value); } });
  await expect(journal.execute('owner', request(), async () => ({ id: 'committed' }))).rejects.toThrow('process terminated');
  expect(await new RecoveryJournal(store).list('owner')).toEqual([request()]);
});
it('keeps accounts isolated and rechecks authorization on replay without discarding revoked work', async () => {
  const { journal } = fixture();
  await expect(journal.execute('owner', request(), async () => { throw new Error('offline'); })).rejects.toThrow();
  expect(await journal.list('another-account')).toEqual([]);
  const authorization = vi.fn(async () => { throw new Error('revoked'); });
  await expect(journal.execute('owner', request(), authorization)).rejects.toThrow('revoked'); expect(authorization).toHaveBeenCalledOnce(); expect(await journal.list('owner')).toEqual([request()]);
});
it('rejects a changed body/version under a pending key', async () => {
  const { journal } = fixture(); await expect(journal.execute('owner', request(), async () => { throw new Error('offline'); })).rejects.toThrow();
  const changed = { ...request(), input: { body: { body: 'Changed', version: 4 } } }, dispatch = vi.fn();
  await expect(journal.execute('owner', changed, dispatch)).rejects.toThrow('earlier request'); expect(dispatch).not.toHaveBeenCalled();
});
it('serializes concurrent persistence with a barrier rather than losing one intent', async () => {
  const { store, journal } = fixture(); let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const first = journal.execute('owner', request(), async () => { entered(); await barrier; throw new Error('first lost'); });
  const caughtFirst = first.catch(() => {}); await started;
  const second = journal.execute('owner', { ...request(), key: 'second-request-key', input: { params: { id: 'case-two' } } }, async () => { throw new Error('second lost'); }).catch(() => {});
  expect(JSON.parse((await store.read('owner'))!)).toHaveLength(1); release(); await Promise.all([caughtFirst, second]);
  expect(await new RecoveryJournal(store).list('owner')).toHaveLength(2);
});
