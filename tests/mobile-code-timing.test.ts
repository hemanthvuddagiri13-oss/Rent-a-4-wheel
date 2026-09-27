import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptanceTiming } from '../src/lib/mobile/acceptance-timing';
const id = '12345678-1234-1234-1234-123456789abc';
import { createBoundedFetch } from '../packages/mobile-client/src/bounded-fetch';
const trace = vi.fn();
const boundedFetch = createBoundedFetch((...args) => fetch(...args), { trace, traceOperation: () => 'requestCode', timingRequestId: () => id });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); trace.mockClear(); });
describe('request-code timing isolation', () => {
  it('only emits allowlisted timing in disposable CI and never changes the server request ID', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = new Request('http://localhost:3001/api/v1/mobile/auth/request-code', { method: 'POST', headers: { 'x-native-timing-id': id, authorization: 'private-header' }, body: 'private-email-phone-otp' });
    vi.stubEnv('CI', 'true'); vi.stubEnv('APP_ENV', 'test'); vi.stubEnv('NATIVE_ACCEPTANCE', '1'); vi.stubEnv('DATABASE_URL', 'postgresql://localhost/disposable_test');
    acceptanceTiming(req)('hash-start', id); acceptanceTiming(req)('private-body', id);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage: 'hash-start', correlationId: id, requestId: id });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    for (const [key, value] of [['APP_ENV', 'staging'], ['NATIVE_ACCEPTANCE', '0'], ['CI', 'false'], ['DATABASE_URL', 'postgresql://localhost/production']]) {
      const old = process.env[key]; vi.stubEnv(key, value); acceptanceTiming(req)('hash-start'); vi.stubEnv(key, old);
    }
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('keeps the 20 second deadline, one issuance attempt, and propagates uncertainty', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('uncertain')))));
    vi.stubGlobal('fetch', fetch);
    const pending = boundedFetch('http://localhost:3000/api/v1/mobile/auth/request-code', { method: 'POST', body: 'synthetic-private-email' });
    const rejection = expect(pending).rejects.toThrow('uncertain');
    await vi.advanceTimersByTimeAsync(19999); expect(trace).not.toHaveBeenCalledWith('deadline', 'requestCode', id);
    await vi.advanceTimersByTimeAsync(1); await rejection;
    expect(fetch).toHaveBeenCalledTimes(1); expect(trace).toHaveBeenCalledWith('request', 'requestCode', id); expect(trace).toHaveBeenCalledWith('deadline', 'requestCode', id); expect(trace).toHaveBeenCalledWith('transport-error', 'requestCode', id);
    expect(JSON.stringify(trace.mock.calls)).not.toContain('synthetic-private');
    expect(fetch.mock.calls[0][1].headers.get('x-native-timing-id')).toBe(id);
  });
});

