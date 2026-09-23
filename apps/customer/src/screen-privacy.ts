import { useEffect, useState } from 'react';
import { preventScreenCaptureAsync, allowScreenCaptureAsync } from 'expo-screen-capture';
import { CaptureLock } from '../../../packages/mobile-client/src/capture-lock';
const protection = new CaptureLock({
  prevent: () => preventScreenCaptureAsync('private-content'),
  allow: () => allowScreenCaptureAsync('private-content'),
});
/** Private content stays hidden until the native protection is acknowledged. */
export function useCaptureProtection() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    const lease = protection.acquire();
    lease.ready.then(() => { if (mounted) setReady(true); }, () => { if (mounted) setReady(false); });
    return () => { mounted = false; void lease.release().catch(() => {}); };
  }, []);
  return ready;
}
