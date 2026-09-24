import { expect, it } from 'vitest';
import { SecureRecoveryStore, type SecureItems } from '../packages/mobile-client/src/secure-recovery-store';

function fixture() {
  const values = new Map<string, string>(); let generation = 0, mutations = 0, failAt = 0, after = false;
  const mutate = (work: () => void) => { mutations++; if (mutations === failAt && !after) throw new Error('process died'); work(); if (mutations === failAt && after) throw new Error('process died after write'); };
  const items: SecureItems = { get: async key => values.get(key) ?? null, set: async (key, value) => { mutate(() => values.set(key, value)); }, remove: async key => { mutate(() => values.delete(key)); } };
  return { values, make: () => new SecureRecoveryStore(items, async scope => scope, () => 'generation-' + ++generation), reset: (at = 0, post = false) => { mutations = 0; failAt = at; after = post; }, count: () => mutations };
}
it.each([false, true])('recovers every secure snapshot mutation boundary (failure after effect: %s) without partial data or orphan chunks', async after => {
  const oldValue = JSON.stringify({ body: 'old'.repeat(220) }), nextValue = JSON.stringify({ body: '🚗'.repeat(750) });
  const probe = fixture(); await probe.make().write('account', oldValue); probe.reset(); await probe.make().write('account', nextValue); const boundaries = probe.count(); expect(boundaries).toBeGreaterThan(5);
  for (let boundary = 1; boundary <= boundaries; boundary++) {
    const f = fixture(); await f.make().write('account', oldValue); f.reset(boundary, after);
    await expect(f.make().write('account', nextValue)).rejects.toThrow('process died');
    f.reset(); const restarted = f.make(), recovered = await restarted.read('account');
    expect([oldValue, nextValue], 'boundary ' + boundary).toContain(recovered);
    await restarted.write('account', '[]'); expect(await restarted.read('account')).toBe('[]');
    expect(f.values.size, 'no unregistered generations at boundary ' + boundary).toBe(2);
  }
});
it('refuses incomplete or corrupt active storage rather than treating it as an empty queue', async () => {
  const f = fixture(); await f.make().write('owner', '[]');
  const chunk = [...f.values.keys()].find(key => key !== 'ra4w.recovery.owner')!; f.values.delete(chunk);
  await expect(f.make().read('owner')).rejects.toThrow('Incomplete');
  f.values.set('ra4w.recovery.owner', '{"active":{"id":"../invalid","count":1}}');
  await expect(f.make().read('owner')).rejects.toThrow('Invalid');
});
it('recovers initial creation failures without exposing a partial first intent', async () => {
  for (const after of [false, true]) for (let boundary = 1; boundary <= 3; boundary++) {
    const f = fixture(); f.reset(boundary, after);
    await expect(f.make().write('new-account', '[]')).rejects.toThrow('process died');
    f.reset(); expect([null, '[]']).toContain(await f.make().read('new-account'));
    await f.make().write('new-account', '[]'); expect(f.values.size).toBe(2);
  }
});
