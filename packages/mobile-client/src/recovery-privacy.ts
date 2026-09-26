import type { RecoveryRecord } from './recovery';
/** The queue needs immutable identity and conflict scope, not a second copy of
 * driver's identity, private message/case text, notes, dates or photo descriptors.
 * Input hashes are salted with the random request key; scope hashes permit
 * conflict comparison across keys. Both remain encrypted at rest. */
export async function protectRecovery(value: string, hash: (value: string) => Promise<string>) {
  const records: RecoveryRecord[] = JSON.parse(value);
  if (!Array.isArray(records)) throw new Error('Invalid recovery queue');
  return JSON.stringify(await Promise.all(records.map(async r => {
    if (!r || typeof r.key !== 'string' || typeof r.operation !== 'string' || typeof r.createdAt !== 'string' || !('input' in r)) throw new Error('Invalid recovery record');
    if (r.redacted && (!r.inputHash || !r.scopeHash)) throw new Error('Missing recovery fingerprint');
    const inputHash = r.inputHash ?? await hash(r.key + ':' + JSON.stringify(r.input));
    const scopeHash = r.scopeHash ?? await hash(r.operation + ':' + JSON.stringify((r.input as { params?: unknown } | null)?.params));
    if (!/^[a-f0-9]{64}$/.test(inputHash) || !/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error('Invalid recovery fingerprint');
    return { key: r.key, operation: r.operation, createdAt: r.createdAt, input: null, inputHash, scopeHash, redacted: true,
      ...(r.intentStorageKey && /^ra4w\.intent\.[a-f0-9]{64}$/.test(r.intentStorageKey) ? { intentStorageKey: r.intentStorageKey } : {}) };
  })));
}
