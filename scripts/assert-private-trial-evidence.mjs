// Require the intended faults, not an unrelated error that happens to match UI copy.
import { readFileSync } from 'node:fs';
if (process.env.CI !== 'true' || process.env.APP_ENV !== 'test') throw new Error('Synthetic acceptance only');
const rows = readFileSync('/tmp/native-proxy.log', 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
for (const kind of ['browser-handoff', 'private-preview']) {
  const matching = rows.filter(row => row.event === 'synthetic.read_interrupted' && row.kind === kind);
  if (matching.length !== 1 || !/^[0-9a-f-]{36}$/i.test(matching[0].requestId ?? '')) throw new Error('Missing or duplicate private-trial read fault: ' + kind);
}
console.log('Private trial: both completed-read interruptions attributed to unique request IDs.');
