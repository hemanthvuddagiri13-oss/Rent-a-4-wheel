import { describe, expect, it, vi } from 'vitest';
import { createAcceptanceTrace } from '../packages/mobile-client/src/acceptance-trace';
describe('acceptance tracing privacy and isolation', () => {
  it('allows only fixed events and strips invalid correlation values', async () => {
    const fetch = vi.fn().mockResolvedValue({});
    const { trace, traceOperation } = createAcceptanceTrace(true, fetch);
    trace('press', 'home-sign-in', 'synthetic-secret-license', 200);
    trace('private-message-body', 'home-sign-in'); trace('press', 'synthetic-secret-case');
    expect(fetch).toHaveBeenCalledTimes(1);
    const row = JSON.parse(fetch.mock.calls[0][1].body);
    expect(row).toMatchObject({ phase: 'press', target: 'home-sign-in', sequence: 1, status: 200 });
    expect(row).not.toHaveProperty('requestId');
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('synthetic-secret');
    expect(fetch.mock.calls[0][1].credentials).toBe('omit');
    expect(traceOperation('http://localhost:3000/api/v1/mobile/cases/private-id/events?cursor=private-cursor', 'GET')).toBe('caseEvents');
    expect(traceOperation('https://example.test/api/v1/mobile/cases/private-id', 'GET')).toBeUndefined();
  });
  it('does not emit outside acceptance and never propagates a delivery failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    let tracing = createAcceptanceTrace(true, fetch);
    expect(() => tracing.trace('press', 'home-sign-in')).not.toThrow(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => createAcceptanceTrace(true, () => { throw new Error('native transport unavailable'); }).trace('press', 'home-sign-in')).not.toThrow();
    tracing = createAcceptanceTrace(false, fetch); tracing.trace('press', 'home-sign-in');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

