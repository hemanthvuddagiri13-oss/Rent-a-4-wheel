import { useRef, useState } from 'react';
import { friendly } from './runtime';
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function run(work: () => Promise<unknown>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await work(); } catch (e) { setError(friendly(e)); } finally { lock.current = false; setBusy(false); } }
  return { busy, error, run };
}
