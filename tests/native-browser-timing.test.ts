import { expect, it } from 'vitest';
import { browserOperation, browserTiming, browserCompileTiming } from '../scripts/native-browser-timing.mjs';

it('allows only the two anonymous browser read families without retaining private inputs', () => {
  expect(browserOperation('GET', '/account/reservations/private-id?email=private@example.test')).toBe('browserReservation');
  expect(browserOperation('GET', '/sign-in?callbackUrl=private-account')).toBe('browserSignIn');
  for (const [method, url] of [['POST', '/sign-in'], ['GET', '/api/v1/mobile/files/private-id'], ['GET', '/account/reservations/id/download'], ['GET', '//other.test/sign-in']]) expect(browserOperation(method, url)).toBeNull();
  const row = { operation: 'browserSignIn', stage: 'upstream-headers', correlationId: '12345678-1234-1234-1234-123456789abc', timestamp: '2026-09-27T00:00:00.000Z', status: 200, requestId: '12345678-1234-1234-1234-123456789abd', url: 'private-url', headers: { authorization: 'private-credential' }, body: 'private-document' };
  expect(browserTiming(row)).toEqual({ event: 'native.browser', operation: row.operation, stage: row.stage, correlationId: row.correlationId, timestamp: row.timestamp, status: 200, requestId: row.requestId });
  expect(JSON.stringify(browserTiming(row))).not.toContain('private');
  for (const invalid of [{ operation: 'private-route' }, { stage: 'private-body' }, { correlationId: 'private-email' }, { timestamp: 'private-content' }]) expect(browserTiming({ ...row, ...invalid })).toBeNull();
  expect(browserTiming({ ...row, requestId: 'private-token', status: 999 })).not.toHaveProperty('requestId');
  expect(browserTiming({ ...row, status: 999 })).not.toHaveProperty('status');
});

it('extracts only numeric development compilation timing, never URLs or private query values', () => {
  expect(browserCompileTiming(' GET /sign-in?callbackUrl=private&email=private@example.test 200 in 27.3s (compile: 27.2s, proxy.ts: 5ms, render: 95ms)')).toEqual({ event: 'native.browser.compile', operation: 'browserSignIn', status: 200, durationMs: 27300, compileMs: 27200 });
  expect(browserCompileTiming(' GET /account/reservations/private-id 307 in 18ms (compile: 1ms, render: 17ms)')).toEqual({ event: 'native.browser.compile', operation: 'browserReservation', status: 307, durationMs: 18, compileMs: 1 });
  for (const line of ['POST /sign-in 200 in 1s (compile: 1s,', 'GET /api/private 200 in 1s (compile: 1s,', 'GET /sign-in 200 in NaNs (compile: 1s,', 'private exception', 'GET /sign-in 200 in 1s (private: body)']) expect(browserCompileTiming(line)).toBeNull();
});
