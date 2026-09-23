import React, { useId, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MobileOperations } from '../../../../packages/mobile-client/src';
import type { Routes } from '../navigation';
import { session, mutate, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, ErrorText, Busy } from '../ui';
import { Upload } from '../upload';
import { useAction } from '../hooks';
import { Pricing } from './reservations';
type Driver = MobileOperations['checkout']['input']['body']['driver'];
const labels: Record<keyof Driver, string> = { firstName: 'First name', lastName: 'Last name', dob: 'Date of birth (YYYY-MM-DD)', email: 'Email', phone: 'Phone', address: 'Street address', city: 'City', state: 'State (two letters)', zip: 'ZIP code', country: 'Country (two letters)', licenseNumber: 'License number', licenseState: 'License state (two letters)', licenseExpiration: 'License expiration (YYYY-MM-DD)' };
export function Checkout({ route }: NativeStackScreenProps<Routes, 'Checkout'>) {
  const captureKey = useId();
  usePreventScreenCapture(captureKey);
  const { id } = route.params, action = useAction();
  const [driver, setDriver] = useState<Driver>({ firstName: '', lastName: '', dob: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: 'US', licenseNumber: '', licenseState: '', licenseExpiration: '' });
  const [docs, setDocs] = useState<{ front?: string; back?: string; selfie?: string }>({}), [acceptedEvidence, setAcceptedEvidence] = useState<string | null>(null), [prepared, setPrepared] = useState(false);
  const q = useQuery({ queryKey: ['checkoutReview', id], queryFn: async ({ signal }) => {
    const [r, pricing, agreement, documents, methods] = await Promise.all([session.call('reservation', { params: { id } }, signal), session.call('pricing', { params: { id } }, signal), session.call('agreementPreview', { params: { id } }, signal), session.call('reservationDocuments', { params: { id } }, signal), session.call('loginMethods', {}, signal)]); return { r, pricing, agreement, documents, methods };
  } });
  const agreementEvidence = q.data ? id + ':' + q.data.agreement.contentHash : null;
  const accepted = agreementEvidence !== null && acceptedEvidence === agreementEvidence;
  return <Page title="Prepare your reservation"><Hint>Private identity and driver information stays in memory only. If the app closes, re-enter it. Existing uploaded documents remain on the server.</Hint>
    {q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : <><Pricing value={q.data.pricing} />
      <Hint>Agreements, receipts and booking notices use your verified account email.</Hint>
      {Object.entries(labels).map(([key, label]) => <Field key={key} label={label} value={key === 'email' ? q.data.methods.email ?? '' : driver[key as keyof Driver] ?? ''} editable={key !== 'email'} onChangeText={value => setDriver(d => ({ ...d, [key]: value }))} autoCorrect={false} autoCapitalize={['email'].includes(key) ? 'none' : 'sentences'} />)}
      {(['front', 'back', 'selfie'] as const).map((key, i) => <React.Fragment key={key}><Upload label={['license front', 'license back', 'selfie with license'][i]} kind={(['LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE'] as const)[i]} reservationId={id} done={documentId => { setDocs(d => ({ ...d, [key]: documentId })); void q.refetch(); }} />{q.data.documents.items.filter(d => d.type === ['LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE'][i]).map(d => <Card key={d.id}><Hint>{d.type}: review {d.status}, scan {d.malwareScanStatus}</Hint><Button title={`Use uploaded ${key}`} disabled={d.malwareScanStatus !== 'CLEAN'} onPress={() => setDocs(old => ({ ...old, [key]: d.id }))} /></Card>)}<Hint>{docs[key] ? 'Document selected' : 'Document required'}</Hint></React.Fragment>)}
      <Card><Copy>Rental agreement · {q.data.agreement.version}</Copy>{q.data.agreement.needsAttorneyReview && <Hint>Draft agreement: attorney review still required. This is staging preparation only.</Hint>}<Copy>{q.data.agreement.content}</Copy><Button title={accepted ? 'Agreement selected — tap to withdraw' : 'I have read and accept this agreement'} onPress={() => setAcceptedEvidence(accepted ? null : agreementEvidence)} /></Card>
      <Button title="Prepare checkout — no payment" disabled={action.busy || !q.data.methods.emailLinked || !accepted || !docs.front || !docs.back || !docs.selfie || prepared} onPress={() => void action.run(async () => { await mutate('checkout', { params: { id }, body: { driver: { ...driver, email: q.data.methods.email! }, documentIds: docs, agreementAccepted: true, agreementContentHash: q.data.agreement.contentHash, bookingFingerprint: q.data.r.bookingFingerprint ?? undefined } }); setPrepared(true); })} />
    </>}
    <ErrorText message={action.error} />{prepared && <Copy>Checkout prepared. Payment and deposit completion are unavailable; this is not a confirmed booking.</Copy>}
    <Button title="Refresh review from server" onPress={() => { setAcceptedEvidence(null); void q.refetch(); }} /></Page>;
}
