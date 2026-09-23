import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { session, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, Busy, ErrorText } from '../ui';
import { useAction } from '../hooks';
type Purpose = 'LINK_EMAIL' | 'LINK_PHONE' | 'CURRENT_PHONE' | 'CHANGE_PHONE' | 'RECOVERY';
export function LoginMethods() {
  const q = useQuery({ queryKey: ['loginMethods'], queryFn: ({ signal }) => session.call('loginMethods', {}, signal) }), action = useAction();
  const [purpose, setPurpose] = useState<Purpose | null>(null), [target, setTarget] = useState(''), [code, setCode] = useState(''), [challengeId, setChallenge] = useState<string | null>(null), [proofId, setProof] = useState<string | undefined>(), [notice, setNotice] = useState(''), [resendAt, setResendAt] = useState(0), [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  function select(value: Purpose) { setPurpose(value); setTarget(''); setCode(''); setChallenge(null); setProof(undefined); setNotice(''); }
  return <Page title="Login & recovery"><Hint>For your security, changes require a sign-in from the last 10 minutes and proof of the method you are adding. If your session is older, log out and sign in again.</Hint>
    {q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : <><Card><Copy>Phone: {q.data.phoneLabel ?? 'Not linked'}</Copy><Copy>Email: {q.data.email ?? 'Not verified — required before booking'}</Copy>{q.data.recoveryId && <Hint>Identity review pending. Reference {q.data.recoveryId}. Your existing login and financial permissions are unchanged.</Hint>}</Card>
      {!q.data.emailLinked && <Button title="Verify an email for booking" onPress={() => select('LINK_EMAIL')} />}
      {!q.data.phoneLinked ? <Button title="Link a verified phone" onPress={() => select('LINK_PHONE')} /> : <><Button title="Change phone — I have my current number" onPress={() => select('CURRENT_PHONE')} /><Button title="Lost phone — request identity review" disabled={!q.data.emailLinked} onPress={() => select('RECOVERY')} /></>}
    </>}
    {purpose && <Card><Copy>{purpose === 'LINK_EMAIL' ? 'Link your email' : purpose === 'CURRENT_PHONE' ? 'Prove your current phone first' : purpose === 'CHANGE_PHONE' ? 'Verify your replacement phone' : purpose === 'RECOVERY' ? 'Verify a replacement for review' : 'Link your phone'}</Copy>
      {purpose === 'RECOVERY' && <Hint>This creates a support review request only. No number, login access or financial permission changes until a separately authorized identity recovery review is complete. There is currently no automated recovery approval.</Hint>}
      <Field label={purpose === 'LINK_EMAIL' ? 'Email to verify' : 'Phone to verify'} value={target} keyboardType={purpose === 'LINK_EMAIL' ? 'email-address' : 'phone-pad'} autoCapitalize="none" onChangeText={value => { setTarget(value); setChallenge(null); setCode(''); }} />
      <Button title={remaining ? `Request another code in ${remaining}s` : 'Send verification code'} disabled={action.busy || remaining > 0 || !target.trim()} onPress={() => void action.run(async () => { const result = await session.call('requestIdentityCode', { body: { purpose, target, proofId } }); setChallenge(result.challengeId); setResendAt(Date.now() + result.retryAfterSeconds * 1000); })} />
      {challengeId && <><Field label="Verification code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" /><Button title="Verify login method" disabled={action.busy || !/^\d{6}$/.test(code)} onPress={() => void action.run(async () => {
        const result = await session.call('verifyIdentityCode', { body: { challengeId, code } }); setCode(''); setChallenge(null);
        if (result.requiresSignIn) { await session.forgetRevokedSession(); return; }
        if (result.outcome === 'PROVED') { setProof(result.proofId ?? undefined); setPurpose('CHANGE_PHONE'); setTarget(''); setResendAt(0); setNotice('Current phone verified. Enter the replacement within five minutes. Changing it signs out all app devices.'); }
        else { setPurpose(null); setNotice(result.outcome === 'REVIEW_REQUIRED' ? 'Identity review requested. Follow the request in Support & cases. Your existing phone remains linked.' : 'Login method verified and linked. Other app devices have been signed out.'); await q.refetch(); }
      })} /></>}
    </Card>}
    <ErrorText message={action.error} /><Hint>{notice}</Hint><Button title="Refresh login methods" onPress={() => { void q.refetch(); }} />
  </Page>;
}
