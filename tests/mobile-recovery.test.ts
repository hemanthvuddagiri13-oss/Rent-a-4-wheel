import { expect, it, vi } from 'vitest';
import { createMobileClient, MobileApiError } from '../packages/mobile-client/src';
import { IntentKeys, RecoveryJournal, type RecoveryRecord, type RecoveryStore } from '../packages/mobile-client/src/recovery';
const request = (): RecoveryRecord => ({ key: 'original-request-key', operation: 'replyCase', input: { params: { id: 'case-one' }, body: { body: 'Synthetic reply', version: 3 } }, createdAt: '2026-09-24T00:00:00Z' });

it.each([401, 404, 429])('an earlier uncertain delivery is not erased by later HTTP %s across restart', async status => {
  const { journal, store } = fixture();
  await expect(journal.execute('owner', request(), async () => { throw new Error('Lost first response'); })).rejects.toThrow();
  const client = createMobileClient({ baseUrl: 'https://synthetic.invalid', accessToken: async () => 'synthetic', fetch: async () => new Response(JSON.stringify({ data: null, requestId: 'later', error: { code: status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : 'RATE_LIMITED', nonCommit: { idempotencyKey: request().key } } }), { status, headers: { 'x-api-version': '1', 'x-request-id': 'later' } }) });
  await expect(new RecoveryJournal(store).execute('owner', request(), r => client.call('replyCase', { ...(r.input as { params: { id: string }; body: { body: string; version: number } }), idempotencyKey: r.key }))).rejects.toThrow();
  expect(await new RecoveryJournal(store).list('owner')).toEqual([request()]);
});

it.each(['no-proof', 'wrong-key', 'wrong-request-id', 'server-error', 'malformed'])('unproven %s response preserves immutable intent across restart', async kind => {
  const { journal, store } = fixture();
  const client = createMobileClient({ baseUrl: 'https://synthetic.invalid', accessToken: async () => 'synthetic', fetch: async () => new Response(kind === 'malformed' ? '{' : JSON.stringify({ data: null, requestId: kind === 'wrong-request-id' ? 'other' : 'request', error: { code: 'CONFLICT', ...(kind === 'no-proof' ? {} : { nonCommit: { idempotencyKey: kind === 'wrong-key' ? 'different-request-key' : request().key } }) } }), { status: kind === 'server-error' ? 500 : 409, headers: { 'x-api-version': '1', 'x-request-id': 'request' } }) });
  await expect(journal.execute('owner', request(), r => client.call('replyCase', { ...(r.input as { params: { id: string }; body: { body: string; version: number } }), idempotencyKey: r.key }))).rejects.toThrow();
  const restarted = new RecoveryJournal(store); expect(await restarted.list('owner')).toEqual([request()]);
  await expect(restarted.execute('owner', { ...request(), key: 'replacement-request-key', input: { params: { id: 'case-one' }, body: { body: 'Edited', version: 4 } } }, vi.fn())).rejects.toThrow('earlier request');
});
it('failed rejection acknowledgement retains the intent until durable proof is replayed after restart', async () => {
  const { store } = fixture(); let writes = 0;
  const journal = new RecoveryJournal({ ...store, write: async (key, value) => { if (++writes === 2) throw new Error('locked during rejection acknowledgement'); await store.write(key, value); } });
  const rejected = async () => { throw new MobileApiError(409, 'CONFLICT', 'request', request().key); };
  await expect(journal.execute('owner', request(), rejected)).rejects.toThrow('locked');
  const restarted = new RecoveryJournal(store); expect(await restarted.list('owner')).toEqual([request()]);
  await expect(restarted.execute('owner', request(), rejected)).rejects.toMatchObject({ nonCommitKey: request().key });
  expect(await restarted.list('owner')).toEqual([]);
});
function fixture() { const values = new Map<string, string>(); const store: RecoveryStore = { read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); } }; return { values, store, journal: new RecoveryJournal(store) }; }
it('concurrent key requests share one identity and a stale acknowledgement cannot erase its successor', async () => {
  const values = new Map<string, string>(); let index = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const keys = new IntentKeys({ get: async key => { await barrier; return values.get(key) ?? null; }, set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } }, () => 'key-' + ++index);
  const first = keys.get('hash'), concurrent = keys.get('hash'); release();
  expect(await Promise.all([first, concurrent])).toEqual(['key-1', 'key-1']);
  await keys.acknowledge('hash', 'key-1'); expect(await keys.get('hash')).toBe('key-2');
  await keys.acknowledge('hash', 'key-1'); expect(await keys.get('hash')).toBe('key-2');
});
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
it('freezes the submitted input before any asynchronous storage work', async () => {
  const { journal } = fixture(), input = request();
  const submitted = journal.execute('owner', input, async frozen => { expect(frozen).toEqual(request()); });
  (input.input as { body: { body: string } }).body.body = 'Edited while waiting';
  await submitted;
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

// Production Session + runtime + chunked secure store. The only fixtures here
// are OS storage and HTTP delivery; server effects are covered by PostgreSQL tests.
import { createHash, randomUUID } from 'node:crypto';
import { Session, type Credentials } from '../packages/mobile-client/src/session';
import { createMutationRuntime } from '../packages/mobile-client/src/mutation-runtime';
import { SecureRecoveryStore } from '../packages/mobile-client/src/secure-recovery-store';
const hash = async (v: string) => createHash('sha256').update(v).digest('hex');
async function privacyRuntime() {
  const raw = new Map<string, string>();
  const credentials = { sessionId: 'synthetic-session', accessToken: 'synthetic-access-secret', refreshToken: 'synthetic-refresh-secret', accessExpiresAt: '2099-01-01T00:00:00Z', refreshExpiresAt: '2099-02-01T00:00:00Z' } as Credentials;
  raw.set('session', JSON.stringify({ credentials }));
  let revoked = false, refuseDelete = false;
  const items = { get: async (k: string) => raw.get(k) ?? null, set: async (k: string, v: string) => { raw.set(k, v); }, remove: async (k: string) => { if (!refuseDelete) raw.delete(k); } };
  const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, error: status === 401 ? { code: 'UNAUTHORIZED' } : null, requestId: 'fixture' }), { status, headers: { 'x-api-version': '1', 'x-request-id': 'fixture' } });
  const restart = () => {
    const session = new Session({ get: () => items.get('session'), set: v => items.set('session', v), clear: async () => { await items.remove('session'); if (raw.has('session')) throw new Error('Deletion pending'); } }, 'https://synthetic.invalid', async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (revoked) return response(null, 401);
      if (path.endsWith('/me')) return response({ id: 'synthetic-owner' });
      if (path.endsWith('/auth/revoke')) return response({ revoked: true });
      if (path.endsWith('/logout') || path.endsWith('/logout-all')) return response({ ok: true });
      if (path.endsWith('/recovery/resolve')) return response({ outcome: 'NOT_COMMITTED', idempotencyKey: JSON.parse(String(init?.body)).idempotencyKey });
      throw new TypeError('Uncertain delivery');
    });
    const store = new SecureRecoveryStore(items, hash, randomUUID);
    const runtime = createMutationRuntime({ session, store, intentKeys: new IntentKeys(items, randomUUID), hashString: hash, hashBytes: async v => createHash('sha256').update(v).digest('hex') });
    return { session, store, ...runtime };
  };
  return { raw, restart, revoke: () => { revoked = true; }, refuseDeletion: (v: boolean) => { refuseDelete = v; } };
}

it('runtime persists no checkout identity, message/case text or handoff notes, including after restart', async () => {
  const f = await privacyRuntime(); let app = f.restart(); await app.session.restore();
  const secrets = ['SYNTHETIC-LICENSE-773', 'SYNTHETIC-ADDRESS-924', 'SYNTHETIC-MESSAGE-883', 'SYNTHETIC-CASE-567', 'SYNTHETIC-HANDOFF-398', '1987-02-13', 'SYNTHETIC-DRIVER-NAME', 'SYNTHETIC-REVIEW-872', 'SYNTHETIC-UPLOAD-RESERVATION', 'SYNTHETIC-UPLOAD-LABEL'];
  const inputs = [
    ['checkout', { params: { id: 'reservation' }, body: { driver: { licenseNumber: secrets[0], address: secrets[1], dateOfBirth: secrets[5], firstName: secrets[6] } } }],
    ['sendMessage', { params: { id: 'conversation' }, body: { body: secrets[2] } }],
    ['openCase', { body: { title: secrets[3], body: secrets[3], reservationId: 'reservation' } }],
    ['hostHandoff', { params: { id: 'reservation' }, body: { notes: secrets[4] } }],
    ['saveReview', { params: { id: 'review-reservation' }, body: { body: secrets[7], rating: 5 } }],
  ] as const;
  for (const [op, input] of inputs) await expect(app.mutate(op, input as never)).rejects.toThrow('Uncertain delivery');
  await expect(app.uploadWithRecovery({ reservationId: secrets[8], type: 'LICENSE_FRONT', mimeType: 'image/png', size: 3, sha256: 'a'.repeat(64) } as never, secrets[9], new Uint8Array([7, 8, 9]))).rejects.toThrow('Uncertain delivery');
  for (const secret of secrets) expect(JSON.stringify([...f.raw])).not.toContain(secret);
  app = f.restart(); await app.session.restore();
  const records = await app.pendingRequests(); expect(records).toHaveLength(6);
  for (const record of records) { expect(record.input).toBeNull(); expect(record.inputHash).toMatch(/^[a-f0-9]{64}$/); }
  await expect(app.mutate('sendMessage', { params: { id: 'conversation' }, body: { body: 'replacement' } })).rejects.toThrow('earlier request');
  // Exact re-entry still dispatches under the original key; metadata-only recovery
  // can settle/fence it without reconstructing sensitive inputs.
  await expect(app.mutate('sendMessage', inputs[1][1])).rejects.toThrow('Uncertain delivery');
  expect((await app.pendingRequests()).map(r => r.key)).toEqual(records.map(r => r.key));
  expect(await app.recoverRequest(records[1])).toEqual({ outcome: 'NOT_COMMITTED', idempotencyKey: records[1].key });
  expect(await app.pendingRequests()).toHaveLength(5);
});

it.each(['logout', 'logout-all', 'revocation', 'forget', 'self-revoke'] as const)('%s removes credentials and redacts registered legacy queues while preserving immutable recovery metadata', async ending => {
  const f = await privacyRuntime(), app = f.restart(); await app.session.restore();
  const legacy = { ...request(), input: { params: { id: 'legacy-case' }, body: { body: 'SYNTHETIC-LEGACY-PRIVATE-TEXT' } } };
  await app.store.write('synthetic-owner', JSON.stringify([legacy]));
  expect(JSON.stringify([...f.raw])).toContain('SYNTHETIC-LEGACY-PRIVATE-TEXT');
  if (ending === 'logout') await app.session.logout();
  if (ending === 'logout-all') await app.session.logout(true);
  if (ending === 'self-revoke') await app.session.call('revokeDevice', { body: { sessionId: 'synthetic-session' } });
  if (ending === 'forget') await app.session.forgetRevokedSession();
  if (ending === 'revocation') { f.revoke(); await expect(app.session.call('me', {})).rejects.toThrow(); }
  const disk = JSON.stringify([...f.raw]);
  expect(disk).not.toContain('SYNTHETIC-LEGACY-PRIVATE-TEXT'); expect(disk).not.toContain('synthetic-access-secret'); expect(disk).not.toContain('synthetic-refresh-secret');
  expect(disk).toContain(legacy.key);
  const restarted = f.restart(); expect(await restarted.session.restore()).toBe(false);
  const [retained] = JSON.parse((await restarted.store.read('synthetic-owner'))!); expect(retained.input).toBeNull(); expect(retained.key).toBe(legacy.key);
});

it('failed legacy purge keeps a credential-free ending marker and blocks restart until native deletion succeeds', async () => {
  const f = await privacyRuntime(), app = f.restart(); await app.session.restore();
  await app.store.write('synthetic-owner', JSON.stringify([{ ...request(), input: { body: 'SYNTHETIC-DELETE-PENDING' } }]));
  f.refuseDeletion(true);
  await expect(app.session.logout()).rejects.toThrow('cleanup remains pending');
  expect(f.raw.get('session')).toBe('{"ending":true}');
  expect(JSON.stringify([...f.raw])).toContain('SYNTHETIC-DELETE-PENDING'); // honest failure, never report purged
  await expect(f.restart().session.restore()).rejects.toThrow('cleanup remains pending');
  f.refuseDeletion(false); expect(await f.restart().session.restore()).toBe(false);
  expect(JSON.stringify([...f.raw])).not.toContain('SYNTHETIC-DELETE-PENDING'); expect(f.raw.has('session')).toBe(false);
});


it('restoration redacts registered legacy inputs before exposing credentials; revisiting an unindexed legacy scope also redacts it', async () => {
  const f = await privacyRuntime(); const old = f.restart();
  await old.store.write('synthetic-owner', JSON.stringify([{ ...request(), input: { body: 'SYNTHETIC-UPGRADE-TEXT' } }]));
  const registered = f.restart(); expect(await registered.session.restore()).toBe(true);
  expect(JSON.stringify([...f.raw])).not.toContain('SYNTHETIC-UPGRADE-TEXT');
  await old.store.write('synthetic-owner', JSON.stringify([{ ...request(), input: { body: 'SYNTHETIC-UNINDEXED-TEXT' } }]));
  f.raw.delete('ra4w.recovery.registry');
  const unindexed = f.restart(); expect(await unindexed.session.restore()).toBe(true);
  expect(JSON.stringify([...f.raw])).toContain('SYNTHETIC-UNINDEXED-TEXT'); // cannot enumerate old native keys
  const [record] = await unindexed.pendingRequests(); expect(record.input).toBeNull();
  expect(JSON.stringify([...f.raw])).not.toContain('SYNTHETIC-UNINDEXED-TEXT');
});
