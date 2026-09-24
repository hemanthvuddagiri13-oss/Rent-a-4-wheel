import React, { useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { mutate, friendly } from './runtime';
import { Button, Card, Hint, ErrorText } from './ui';
type Kind = 'LICENSE_FRONT' | 'LICENSE_BACK' | 'SELFIE_WITH_LICENSE' | 'INSPECTION';
export function Upload({ label, kind, reservationId, done }: { label: string; kind: Kind; reservationId: string; done: (documentId: string, uploadId: string) => void }) {
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset | null>(null), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState('');
  const cache = useRef<string[]>([]), lock = useRef(false);
  useEffect(() => () => { for (const uri of cache.current) { if (uri.startsWith(Paths.cache.uri)) { try { new File(uri).delete(); } catch {} } } }, []);
  async function choose(camera: boolean) {
    setError('');
    try {
      const permission = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { setError('Photo access was not granted. You can enable it in device settings when ready.'); return; }
      const result = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85, exif: false }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85, exif: false });
      if (!result.canceled) { cache.current.push(result.assets[0].uri); setAsset(result.assets[0]); setProgress('Photo selected. Nothing has been uploaded yet.'); }
    } catch { setError('Unable to open photos. Check device permissions and try again.'); }
  }
  async function send() {
    if (!asset || lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      setProgress('Preparing private image…');
      const bytes = await new File(asset.uri).bytes();
      const mimeType = asset.mimeType;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType ?? '') || bytes.length > 8388608) { setError('Choose a JPEG, PNG or WebP image smaller than 8 MB.'); return; }
      const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
      const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      const initialized = await mutate('initializeUpload', { body: { reservationId, type: kind, mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', size: bytes.length, sha256 } });
      setProgress(`Uploading ${(bytes.length / 1024).toFixed(0)} KB and waiting for security scanning…`);
      const result = await mutate('finalizeUpload', { params: { id: initialized.id }, body: bytes, contentType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' });
      done(result.id, initialized.id); setProgress(`${label}: Upload completed and scanned. Eligibility review may still be pending.`); setAsset(null);
      if (asset.uri.startsWith(Paths.cache.uri)) new File(asset.uri).delete();
    } catch (e) { setError(friendly(e)); setProgress(`${label}: Upload not confirmed. Keep this screen open and retry the same photo after reconnecting.`); }
    finally { setBusy(false); lock.current = false; }
  }
  return <Card><Hint>{label}. Camera access is only used when you choose to capture a photo. Evidence is stored privately and scanned before use.</Hint><Button title={`Take ${label}`} disabled={busy} onPress={() => void choose(true)} /><Button title={`Choose ${label}`} disabled={busy} onPress={() => void choose(false)} />{asset && <Button title={`Upload ${label}`} disabled={busy} onPress={() => void send()} />}<Hint>{progress}</Hint><ErrorText message={error} /></Card>;
}
