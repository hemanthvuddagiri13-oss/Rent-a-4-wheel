import { expect, it } from 'vitest';
import { browserOperation, browserTiming, browserServerTiming } from '../scripts/native-browser-timing.mjs';

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

it('extracts only numeric development framework timing, never URLs or private query values', () => {
  expect(browserServerTiming(' GET /sign-in?callbackUrl=private&email=private@example.test 200 in 27.3s (next.js: 27.2s, proxy.ts: 5ms, application-code: 95ms)')).toEqual({ event: 'native.browser.server', operation: 'browserSignIn', status: 200, durationMs: 27300, frameworkMs: 27200 });
  expect(browserServerTiming(' GET /account/reservations/private-id 307 in 18ms (next.js: 1ms, application-code: 17ms)')).toEqual({ event: 'native.browser.server', operation: 'browserReservation', status: 307, durationMs: 18, frameworkMs: 1 });
  expect(browserServerTiming(' GET /sign-in 200 in 2.1min (next.js: 2.0min, application-code: 6s)')).toMatchObject({ durationMs: 126000, frameworkMs: 120000 });
  for (const line of ['POST /sign-in 200 in 1s (next.js: 1s,', 'GET /api/private 200 in 1s (next.js: 1s,', 'GET /sign-in 200 in NaNs (next.js: 1s,', 'private exception', 'GET /sign-in 200 in 1s (private: body)']) expect(browserServerTiming(line)).toBeNull();
});
