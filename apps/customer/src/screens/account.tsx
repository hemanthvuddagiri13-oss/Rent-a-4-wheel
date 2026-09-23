import React, { useState } from 'react';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { publicApi, session, deviceId, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, ErrorText, Busy } from '../ui';
import { useAction } from '../hooks';
export function SignIn() {
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false), action = useAction();
  return <Page title="Welcome to your next trip."><Hint>We’ll email a one-time code. No password to remember.</Hint><Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
    <Button title={sent ? 'Send a new code' : 'Send sign-in code'} disabled={action.busy || !email.includes('@')} onPress={() => void action.run(async () => { await publicApi.call('requestCode', { body: { email: email.trim().toLowerCase() } }); setSent(true); })} />
    {sent && <><Hint>If this address can sign in, a code is on its way. Codes expire in 10 minutes. Wait at least 60 seconds before requesting another.</Hint><Field label="Six-digit email code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" /><Button title="Verify & sign in" disabled={action.busy || !/^\d{6}$/.test(code)} onPress={() => void action.run(async () => { await session.signIn({ body: { email: email.trim().toLowerCase(), code, deviceId: await deviceId(), platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID', appVersion: '0.1.0' } }); setCode(''); })} /></>}
    <ErrorText message={action.error} /><Hint>Your device credentials are stored in iOS Keychain or Android encrypted secure storage. A lost refresh response requires a new sign-in.</Hint></Page>;
}
export function Account() {
  const q = useQuery({ queryKey: ['devices'], queryFn: ({ signal }) => session.call('devices', {}, signal) }), action = useAction();
  return <Page title="Account & devices"><Hint>Revoking a device ends its native app access. Website sessions are managed separately.</Hint>{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : q.data.devices.map(d => <Card key={d.id}><Copy>{d.platform} · App {d.appVersion}</Copy><Hint>Last active {new Date(d.lastUsedAt).toLocaleString()}</Hint><Button title={`Revoke ${d.platform} device`} disabled={action.busy} onPress={() => void action.run(async () => { await session.call('revokeDevice', { body: { sessionId: d.id } }); await q.refetch(); })} /></Card>)}
    <ErrorText message={action.error} /><Button title="Refresh devices" onPress={() => { void q.refetch(); }} /><Button title="Log out this device" disabled={action.busy} onPress={() => void action.run(() => session.logout())} /><Button title="Log out all app devices" disabled={action.busy} onPress={() => void action.run(() => session.logout(true))} /><Hint>Logout requires a connection so the server can revoke access. If it fails, reconnect and retry.</Hint></Page>;
}
