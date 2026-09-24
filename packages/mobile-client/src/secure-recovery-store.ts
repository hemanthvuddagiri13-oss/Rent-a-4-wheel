import type { RecoveryStore } from './recovery';
export interface SecureItems { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
type Generation = { id: string; count: number };
type Pointer = { active: Generation | null; pending?: Generation; garbage?: Generation };
function generation(value: unknown): value is Generation {
  const v = value as Generation | null;
  return !!v && typeof v.id === 'string' && /^[a-zA-Z0-9-]+$/.test(v.id) && Number.isInteger(v.count) && v.count > 0 && v.count <= 10000;
}
/** Requires encrypted device-local storage. Write-ahead pointers register chunks
 * BEFORE creation and until cleanup completes, including after process death. */
export class SecureRecoveryStore implements RecoveryStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private items: SecureItems, private hash: (scope: string) => Promise<string>, private random: () => string) {}
  private serial<T>(work: () => Promise<T>) { const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next; }
  private async remove(key: string, value: Generation) {
    for (let i = 0; i < value.count; i++) {
      const chunk = key + '.' + value.id + '.' + i;
      await this.items.remove(chunk);
      // Expo's iOS delete wrapper discards SecItemDelete status. Do not forget
      // the cleanup registry merely because that wrapper resolved.
      if (await this.items.get(chunk) !== null) throw new Error('Secure recovery cleanup remains pending');
    }
  }
  private async pointer(key: string): Promise<Pointer> {
    const raw = await this.items.get(key); if (raw === null) return { active: null };
    const p = JSON.parse(raw) as Pointer;
    if (!p || (p.active !== null && !generation(p.active)) || (p.pending !== undefined && !generation(p.pending)) || (p.garbage !== undefined && !generation(p.garbage)) || (p.pending !== undefined && p.pending.id === p.active?.id) || (p.garbage !== undefined && p.garbage.id === p.active?.id)) throw new Error('Invalid secure recovery pointer');
    if (p.pending) await this.remove(key, p.pending);
    if (p.garbage) await this.remove(key, p.garbage);
    if (p.pending || p.garbage) await this.items.set(key, JSON.stringify({ active: p.active }));
    return { active: p.active };
  }
  read(scope: string) { return this.serial(async () => {
    const key = 'ra4w.recovery.' + await this.hash(scope), p = await this.pointer(key);
    if (!p.active) return null;
    let value = '';
    for (let i = 0; i < p.active.count; i++) { const part = await this.items.get(key + '.' + p.active.id + '.' + i); if (part === null) throw new Error('Incomplete secure recovery record'); value += part; }
    return value;
  }); }
  write(scope: string, value: string) { return this.serial(async () => {
    const key = 'ra4w.recovery.' + await this.hash(scope), p = await this.pointer(key), points = Array.from(value), chunks: string[] = [];
    for (let i = 0; i < points.length; i += 300) chunks.push(points.slice(i, i + 300).join(''));
    if (!chunks.length) chunks.push('');
    const next = { id: this.random(), count: chunks.length };
    if (!generation(next) || next.id === p.active?.id) throw new Error('Invalid secure recovery generation');
    await this.items.set(key, JSON.stringify({ active: p.active, pending: next }));
    for (let i = 0; i < chunks.length; i++) await this.items.set(key + '.' + next.id + '.' + i, chunks[i]);
    await this.items.set(key, JSON.stringify({ active: next, ...(p.active ? { garbage: p.active } : {}) }));
    await this.pointer(key);
  }); }
}
