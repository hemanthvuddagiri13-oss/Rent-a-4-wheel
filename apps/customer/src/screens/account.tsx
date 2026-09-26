import { trace } from '../acceptance-trace';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { useQuery } from '@tanstack/react-query';
import { publicApi, session, deviceId, friendly, hostApp } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, ErrorText, Busy } from '../ui';
import { useAction } from '../hooks';
// Keep countdown ticks local: typing into controlled phone/code fields must
// not receive unrelated once-per-second parent renders. The server still owns
// the actual resend limit; this is only its user-visible countdown.
function PhoneCodeButton({ resendAt, hasChallenge, disabled, onPress }: { resendAt: number; hasChallenge: boolean; disabled: boolean; onPress: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = setInterval(() => { const current = Date.now(); setNow(current); if (current >= resendAt) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  return <Button title={remaining ? `Resend available in ${remaining}s` : hasChallenge ? 'Resend text code' : 'Send text code'} disabled={disabled || remaining > 0} onPress={onPress} />;
}
export function SignIn() {
  useEffect(() => { trace('mount', 'SignIn'); return () => trace('unmount', 'SignIn'); }, []);
  const navigation = useNavigation<NativeStackNavigationProp<Routes>>(), action = useAction();
  const [phone, setPhone] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState<string | null>(null), [resendAt, setResendAt] = useState(0);
  return <Page titleTestID="phone-sign-in-screen" title={hostApp ? "Welcome to hosting." : "Welcome to your next trip."}><Hint>{hostApp ? "Sign in with the number linked to your existing host membership. Verification does not grant host permissions. Include your country code." : "Sign in or create your customer account with a verified mobile number. Include your country code; US numbers can also use the usual ten-digit format."}</Hint>
    <Field label="Mobile phone number" value={phone} onChangeText={value => { setPhone(value); setChallenge(null); setCode(''); }} keyboardType="phone-pad" autoComplete="tel" />
    <PhoneCodeButton key={resendAt} resendAt={resendAt} hasChallenge={Boolean(challenge)} disabled={action.busy || phone.trim().length < 7} onPress={() => void action.run(async () => { const sent = await publicApi.call('requestPhoneCode', { body: { phone, deviceId: await deviceId() } }); setChallenge(sent.challengeId); setResendAt(Date.now() + sent.retryAfterSeconds * 1000); setCode(''); })} />
    {challenge && <><Hint>If this number can receive a code, a text is on its way. Codes expire in 10 minutes. Message and data rates may apply.</Hint><Field label="Six-digit text code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" /><Button title="Verify phone & continue" disabled={action.busy || !/^\d{6}$/.test(code)} onPress={() => void action.run(async () => { await session.signInPhone({ body: { challengeId: challenge, code, deviceId: await deviceId(), platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID', appVersion: '0.1.0' } }); setCode(''); })} /></>}
    <ErrorText message={action.error} /><Button testID="email-fallback" title="Use verified email instead" onPress={() => (trace('navigation', 'EmailSignIn'), navigation.navigate('EmailSignIn'))} /><Hint>Email fallback works only for an email previously verified and linked to your account. A new phone account must link a verified email before booking.</Hint>
    <Card><Copy>Lost or changed your phone?</Copy><Hint>Use your linked email to sign in, then open Login & recovery in Account. Replacing a lost number requires identity review; verifying a replacement number alone does not transfer an account. If you cannot access either method, contact support through the official website. Never send codes or identity photos in a message.</Hint></Card>
  </Page>;
}
export function EmailSignIn() {
  useEffect(() => { trace('mount', 'EmailSignIn'); return () => trace('unmount', 'EmailSignIn'); }, []);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false), action = useAction();
  return <Page titleTestID="email-sign-in-screen" title="Sign in with linked email"><Hint>Use an email already verified and linked to your account. This fallback does not create or merge accounts. New customers start with phone verification.</Hint><Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
    <Button title={sent ? 'Send a new code' : 'Send sign-in code'} disabled={action.busy || !email.includes('@')} onPress={() => void action.run(async () => { await publicApi.call('requestCode', { body: { email: email.trim().toLowerCase() } }); setSent(true); })} />
    {sent && <><Hint>If this address can sign in, a code is on its way. Codes expire in 10 minutes. Wait at least 60 seconds before requesting another.</Hint><Field label="Six-digit email code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" /><Button title="Verify & sign in" disabled={action.busy || !/^\d{6}$/.test(code)} onPress={() => void action.run(async () => { await session.signIn({ body: { email: email.trim().toLowerCase(), code, deviceId: await deviceId(), platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID', appVersion: '0.1.0' } }); setCode(''); })} /></>}
    <ErrorText message={action.error} /><Hint>Your device credentials are stored in iOS Keychain or Android encrypted secure storage. A lost refresh response requires a new sign-in.</Hint></Page>;
}
export function Account() {
  const navigation = useNavigation<NativeStackNavigationProp<Routes>>();
  const q = useQuery({ queryKey: ['devices'], queryFn: ({ signal }) => session.call('devices', {}, signal) }), action = useAction();
  return <Page title="Account & devices"><Button testID="open-recovery" title="Interrupted requests" onPress={() => { trace('navigation', 'Recovery'); navigation.navigate('Recovery'); }} /><Button title="Login & recovery" onPress={() => navigation.navigate('LoginMethods')} /><Hint>Revoking a device ends its native app access. Website sessions are managed separately.</Hint>{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : q.data.devices.map(d => <Card key={d.id}><Copy>{d.platform} · App {d.appVersion}</Copy><Hint>Last active {new Date(d.lastUsedAt).toLocaleString()}</Hint><Button title={`Revoke ${d.platform} device`} disabled={action.busy} onPress={() => void action.run(async () => { await session.call('revokeDevice', { body: { sessionId: d.id } }); await q.refetch(); })} /></Card>)}
    <ErrorText message={action.error} /><Button title="Refresh devices" onPress={() => { void q.refetch(); }} /><Button title="Log out this device" disabled={action.busy} onPress={() => void action.run(() => session.logout())} /><Button title="Log out all app devices" disabled={action.busy} onPress={() => void action.run(() => session.logout(true))} /><Hint>Logout requires a connection so the server can revoke access. If it fails, reconnect and retry.</Hint></Page>;
}
