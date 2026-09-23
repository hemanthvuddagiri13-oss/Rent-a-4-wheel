import { expect, it, vi } from 'vitest';
import { Session, SignInRequired, type Credentials } from '../packages/mobile-client/src/session';
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
