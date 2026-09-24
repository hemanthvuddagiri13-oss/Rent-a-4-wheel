import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useCaptureProtection } from './screen-privacy';
import { fromByteArray } from 'base64-js';
import { session } from './runtime';
import { useAction } from './hooks';
import { Button, Hint, ErrorText } from './ui';

/** Bytes remain in memory, never a public URL or image/disk cache. Re-open
 * obtains fresh authorization; background/blur/expiry destroys the preview. */
export function PrivateEvidence({ documentId, label, report }: { documentId?: string; label: string; report?: { id: string; reportId: string; photoId: string } }) {
  const captureReady = useCaptureProtection();
  const [uri, setUri] = useState<string | null>(null), action = useAction(), generation = useRef(0);
  const clear = useCallback(() => { generation.current++; setUri(null); }, []);
  useFocusEffect(useCallback(() => clear, [clear]));
  useEffect(() => { const listener = AppState.addEventListener('change', clear); return () => { listener.remove(); clear(); }; }, [clear]);
  useEffect(() => { if (uri) { const timer = setTimeout(clear, 30000); return () => clearTimeout(timer); } }, [uri, clear]);
  if (!captureReady) return <Hint>Private preview unavailable until screen protection is ready. Restart the app if this persists.</Hint>;
  return <><Button title={uri ? "Close private preview" : `View private ${label.replaceAll('_', ' ').toLowerCase()}`} disabled={action.busy} onPress={uri ? clear : () => void action.run(async () => {
    clear(); const epoch = generation.current;
    let result: ArrayBuffer;
    if (report) result = await session.call('reportPhoto', { params: report });
    else {
      const grant = await session.call('documentAccess', { body: { documentId: documentId! } });
      result = await session.call('privateDocument', { params: { id: documentId! }, fileAccess: grant.capability });
    }
    if (epoch !== generation.current || AppState.currentState !== 'active') return;
    const bytes = new Uint8Array(result), mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
    setUri(`data:${mime};base64,${fromByteArray(bytes)}`);
  })} />{uri && <><Image alt={label + ' private preview'} accessible accessibilityLabel={label + ' private preview'} source={{ uri }} resizeMode="contain" style={{ width: '100%', height: 300 }} /><Hint>Preview closes after 30 seconds. Reopen to recheck current access.</Hint></>}<ErrorText message={action.error} /></>;
}
