import React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { session, friendly } from '../runtime';
import { useCaptureProtection } from '../screen-privacy';
import { PrivateEvidence } from '../private-evidence';
import { openPrivateBrowser } from '../browser-handoff';
import { useAction } from '../hooks';
import { Page, Card, Copy, Hint, Button, Busy, ErrorText } from '../ui';
export function Documents({ route }: NativeStackScreenProps<Routes, 'Documents'>) {
  const { id } = route.params, ready = useCaptureProtection(), action = useAction();
  const q = useQuery({ queryKey: ['privateDocuments', id], queryFn: async ({ signal }) => {
    const [documents, signed] = await Promise.all([session.call('reservationDocuments', { params: { id } }, signal), session.call('signedAgreement', { params: { id } }, signal)]);
    return { documents, signed };
  } });
  if (!ready) return <Page title="Private documents"><Hint>Preparing screen protection.</Hint></Page>;
  return <Page titleTestID="private-documents-screen" title="Private documents & signed terms"><Hint>Identity previews stay in memory and close when you leave. PDFs open in a separately authenticated browser; downloaded copies may remain on your device.</Hint>
    {q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : <>
      {!q.data.documents.items.length && <Hint>No identity documents are attached to this reservation.</Hint>}
      {q.data.documents.items.filter(d => ['LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE'].includes(d.type)).map(d => <Card key={d.id}><Copy>{d.type.replaceAll('_', ' ')}</Copy><Hint>Review: {d.status} · Scan: {d.malwareScanStatus}</Hint>{d.malwareScanStatus === 'CLEAN' ? <PrivateEvidence documentId={d.id} label={d.type} /> : <Hint>Private preview unavailable until scanning is clean.</Hint>}</Card>)}
      {q.data.signed.agreement ? <Card><Copy>Signed agreement · {q.data.signed.agreement.documentVersion}</Copy><Hint>Signed: {q.data.signed.agreement.signedAt}</Hint><Hint>SHA-256: {q.data.signed.agreement.contentHash}</Hint><Copy>{q.data.signed.agreement.contentSnapshot}</Copy>{q.data.signed.agreement.pdfAvailable ? <Button title="Signed PDF in secure browser" disabled={action.busy} onPress={() => void action.run(async () => { const current = await session.call('signedAgreement', { params: { id } }); if (!current.agreement?.pdfAvailable) throw new Error('Unavailable'); await openPrivateBrowser(current.agreement.browserPath); })} /> : <Hint>Signed PDF is not available yet. The frozen terms above are the signed text, not a newly generated PDF.</Hint>}</Card> : <Hint>No signed agreement exists yet. Checkout preparation and legal approval are still required.</Hint>}
    </>}
    <ErrorText message={action.error} /><Button title="Refresh private documents" onPress={() => void q.refetch()} /></Page>;
}
