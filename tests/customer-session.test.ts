import { expect, it, vi } from 'vitest';
import { Session, SignInRequired, type Credentials } from '../packages/mobile-client/src/session';
import { CaptureLock } from '../apps/customer/src/capture-lock';

it('overlapping private views share one acknowledged native capture lock until the last release', async () => {
  let acknowledge!: () => void;
  const barrier = new Promise<void>(resolve => { acknowledge = resolve; });
  const driver = { prevent: vi.fn(() => barrier), allow: vi.fn(async () => {}) };
  const lock = new CaptureLock(driver), screen = lock.acquire(), preview = lock.acquire();
  let ready = false; void preview.ready.then(() => { ready = true; });
  await Promise.resolve(); expect(driver.prevent).toHaveBeenCalledTimes(1); expect(ready).toBe(false);
  acknowledge(); await Promise.all([screen.ready, preview.ready]); expect(ready).toBe(true);
  await preview.release(); await preview.release(); expect(driver.allow).not.toHaveBeenCalled();
  await screen.release(); expect(driver.allow).toHaveBeenCalledTimes(1); expect(driver.prevent).toHaveBeenCalledTimes(1);
});
it('private view remount during native release waits for re-protection without overlapping native calls', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const lock = new CaptureLock({ prevent: async () => { calls.push('prevent'); }, allow: async () => { calls.push('allow:start'); await barrier; calls.push('allow:end'); } });
  const first = lock.acquire(); await first.ready; const releasing = first.release(); await Promise.resolve();
  const next = lock.acquire(); let ready = false; void next.ready.then(() => { ready = true; });
  await Promise.resolve(); expect(ready).toBe(false); expect(calls).toEqual(['prevent', 'allow:start']);
  release(); await releasing; await next.ready;
  expect(calls).toEqual(['prevent', 'allow:start', 'allow:end', 'prevent']); expect(ready).toBe(true);
  await next.release();
});
it('uncertain native capture protection fails closed for current and later private views', async () => {
  const driver = { prevent: vi.fn(async () => { throw new Error('native protection failed'); }), allow: vi.fn(async () => {}) };
  const lock = new CaptureLock(driver), first = lock.acquire();
  await expect(first.ready).rejects.toThrow('native protection failed');
  await expect(first.release()).rejects.toThrow('native protection failed');
  const next = lock.acquire(); await expect(next.ready).rejects.toThrow('native protection failed');
  expect(driver.prevent).toHaveBeenCalledTimes(1); expect(driver.allow).not.toHaveBeenCalled();
  await expect(next.release()).rejects.toThrow('native protection failed');
});
it('uncertain native release cannot make a later private view assume protection is still active', async () => {
  const driver = { prevent: vi.fn(async () => {}), allow: vi.fn(async () => { throw new Error('native release uncertain'); }) };
  const lock = new CaptureLock(driver), first = lock.acquire(); await first.ready;
  await expect(first.release()).rejects.toThrow('native release uncertain');
  const next = lock.acquire(); await expect(next.ready).rejects.toThrow('native release uncertain');
  expect(driver.prevent).toHaveBeenCalledTimes(1); expect(driver.allow).toHaveBeenCalledTimes(1);
  await expect(next.release()).rejects.toThrow('native release uncertain');
});
const credentials = (accessToken = 'access-old', expired = false): Credentials => ({ tokenType: 'Bearer', accessToken, refreshToken: 'refresh-' + accessToken, sessionId: 'synthetic-session', accessExpiresAt: new Date(Date.now() + (expired ? -1000 : 300000)).toISOString(), refreshExpiresAt: new Date(Date.now() + 86400000).toISOString() });
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, error: status >= 400 ? { code: 'UNAUTHORIZED' } : null, requestId: 'synthetic-request' }), { status, headers: { 'x-api-version': '1' } });
function setup(c = credentials()) {
  let stored: string | null = JSON.stringify({ credentials: c });
  const vault = { get: vi.fn(async () => stored), set: vi.fn(async (value: string) => { stored = value; }), clear: vi.fn(async () => { stored = null; }) };
  const transport = vi.fn<typeof fetch>(); const session = new Session(vault, 'https://fixture.invalid', transport);
  return { session, vault, transport, stored: () => stored };
}
it('serializes concurrent refreshes and persists uncertainty before the provider request', async () => {
  const f = setup(credentials('old', true)); await f.session.restore();
  let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
  f.transport.mockImplementation(async () => { expect(JSON.parse(f.stored()!).refreshing).toBe(true); await barrier; return response(credentials('new')); });
  const a = f.session.token(), b = f.session.token(); await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1)); release();
  expect(await Promise.all([a, b])).toEqual(['new', 'new']); expect(f.transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.stored()!).refreshing).toBeUndefined();
});
it('lost refresh response clears credentials and never retries the consumed token', async () => {
  const f = setup(credentials('old', true)); await f.session.restore(); f.transport.mockRejectedValue(new TypeError('network lost'));
  await expect(f.session.token()).rejects.toBeInstanceOf(SignInRequired);
  await expect(f.session.token()).rejects.toBeInstanceOf(SignInRequired); expect(f.transport).toHaveBeenCalledTimes(1); expect(f.stored()).toBeNull();
});
it('a process restart after uncertain rotation requires sign-in without calling refresh', async () => {
  const f = setup(); await f.vault.set(JSON.stringify({ credentials: credentials(), refreshing: true }));
  expect(await f.session.restore()).toBe(false); expect(f.transport).not.toHaveBeenCalled(); expect(f.stored()).toBeNull();
});
it('revoked access and rejected refresh clear the session', async () => {
  const f = setup(); await f.session.restore(); f.transport.mockResolvedValue(response(null, 401));
  await expect(f.session.call('me', {})).rejects.toBeInstanceOf(SignInRequired); expect(f.transport).toHaveBeenCalledTimes(2); expect(f.stored()).toBeNull();
});
it('offline domain requests retain credentials and never retry mutations automatically', async () => {
  const f = setup(); await f.session.restore(); f.transport.mockRejectedValue(new TypeError('offline'));
  const input = { params: { id: 'conversation' }, body: { body: 'Synthetic text' }, idempotencyKey: 'immutable-key-12345' };
  await expect(f.session.call('sendMessage', input)).rejects.toThrow('offline'); expect(f.transport).toHaveBeenCalledTimes(1); expect(f.stored()).not.toBeNull();
  f.transport.mockResolvedValue(response({ id: 'message' })); await f.session.call('sendMessage', input);
  expect(f.transport.mock.calls[1][1]?.headers).toMatchObject({ 'Idempotency-Key': input.idempotencyKey });
});
it('two late 401 responses use one rotation without replaying the old refresh token', async () => {
  const f = setup(); await f.session.restore();
  f.transport.mockImplementation(async (url, init) => String(url).endsWith('/refresh') ? response(credentials('new')) : (init?.headers as Record<string, string>).Authorization === 'Bearer access-old' ? response(null, 401) : response({ id: 'user', role: 'CUSTOMER' }));
  expect(await Promise.all([f.session.call('me', {}), f.session.call('me', {})])).toHaveLength(2);
  expect(f.transport.mock.calls.filter(([url]) => String(url).endsWith('/refresh'))).toHaveLength(1);
});
it('secure-store failure before rotation makes no refresh request', async () => {
  const f = setup(credentials('old', true)); await f.session.restore(); f.vault.set.mockRejectedValue(new Error('locked'));
  await expect(f.session.token()).rejects.toBeInstanceOf(SignInRequired); expect(f.transport).not.toHaveBeenCalled();
});
it('successful logout revokes on server before deleting the secure record', async () => {
  const f = setup(); await f.session.restore(); f.transport.mockImplementation(async () => { expect(f.stored()).not.toBeNull(); return response({ revoked: true }); });
  await f.session.logout(); expect(f.stored()).toBeNull(); expect(f.transport).toHaveBeenCalledTimes(1);
});
it('offline logout preserves credentials for a deliberate revocation retry', async () => {
  const f = setup(); await f.session.restore(); f.transport.mockRejectedValue(new TypeError('offline'));
  await expect(f.session.logout()).rejects.toThrow('offline'); expect(f.stored()).not.toBeNull();
});
it('phone sign-in stores credentials before activating and uses the shared rotation protocol', async () => {
  const f = setup(); await f.vault.clear(); await f.session.restore();
  const changed = vi.fn(() => expect(f.stored()).not.toBeNull()); f.session.onChange = changed;
  f.transport.mockResolvedValueOnce(response(credentials('phone', true))).mockResolvedValueOnce(response(credentials('rotated-phone')));
  await f.session.signInPhone({ body: { challengeId: 'synthetic-challenge', code: '123456', deviceId: 'synthetic-device', platform: 'IOS', appVersion: '1.0.0' } });
  expect(String(f.transport.mock.calls[0][0])).toMatch(/\/auth\/phone-sign-in$/); expect(changed).toHaveBeenCalledWith(true);
  expect(await f.session.token()).toBe('rotated-phone'); expect(f.transport).toHaveBeenCalledTimes(2);
});
it('phone sign-in never activates if secure credential storage fails', async () => {
  const f = setup(); await f.vault.clear(); await f.session.restore();
  const changed = vi.fn(); f.session.onChange = changed; f.vault.set.mockRejectedValue(new Error('keychain unavailable'));
  f.transport.mockResolvedValue(response(credentials('phone')));
  await expect(f.session.signInPhone({ body: { challengeId: 'synthetic-challenge', code: '123456', deviceId: 'synthetic-device', platform: 'IOS', appVersion: '1.0.0' } })).rejects.toThrow('keychain unavailable');
  expect(changed).not.toHaveBeenCalled(); await expect(f.session.token()).rejects.toBeInstanceOf(SignInRequired);
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it.each([200, 401])('discards an old account response (%s) without retrying its operation under a new sign-in', async status => {
  const f = setup(); await f.session.restore();
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  f.transport.mockImplementation(async url => String(url).endsWith('/sign-in') ? response(credentials('new-account')) : pending);
  const old = f.session.call('me', {});
  const assertOriginalIdentity = f.session.captureIdentity();
  await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
  await f.session.signIn({ body: { email: 'new@example.test', code: '123456', deviceId: 'synthetic-device', platform: 'IOS', appVersion: '0.1.0' } });
  finish(response({ id: 'old-account' }, status));
  await expect(old).rejects.toBeInstanceOf(SignInRequired);
  expect(assertOriginalIdentity).toThrow(SignInRequired);
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect(await f.session.token()).toBe('new-account');
  expect(JSON.parse(f.stored()!).credentials.accessToken).toBe('new-account');
});

it('pending reply releases an authoritative conflict but retains uncertain service failures', async () => {
  const { PendingReply } = await import('../packages/mobile-client/src/pending-reply');
  const { MobileApiError } = await import('../packages/mobile-client/src');
  const pending = new PendingReply(), first = { id: 'synthetic', body: 'One reply', version: 1 };
  await expect(pending.send(first, async () => { throw new MobileApiError(503, 'UNAVAILABLE', 'synthetic'); })).rejects.toMatchObject({ status: 503 });
  expect(pending.pending).toBe(true);
  await expect(pending.send({ ...first, version: 2 }, async frozen => { expect(frozen.version).toBe(1); throw new MobileApiError(409, 'CONFLICT', 'synthetic'); })).rejects.toMatchObject({ status: 409 });
  expect(pending.pending).toBe(false);
  await pending.send({ ...first, version: 3 }, async frozen => { expect(frozen.version).toBe(3); });
  expect(pending.pending).toBe(false);
});
