import React, { useState } from 'react';
import { Image } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { fromByteArray } from 'base64-js';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { session, mutate, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, ErrorText, Busy } from '../ui';
import { Upload } from '../upload';
import { useAction } from '../hooks';
export function Inspection({ route }: NativeStackScreenProps<Routes, 'Inspection'>) {
  usePreventScreenCapture();
  const { id } = route.params, action = useAction();
  const [phase, setPhase] = useState<'PRE_TRIP' | 'POST_TRIP'>('PRE_TRIP'), [mileage, setMileage] = useState(''), [fuel, setFuel] = useState(''), [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<Array<{ uploadId: string; category: 'EXTERIOR' | 'INTERIOR' | 'DAMAGE' }>>([]);
  const q = useQuery({ queryKey: ['reports', id], queryFn: ({ signal }) => session.call('reports', { params: { id } }, signal) });
  return <Page title="Vehicle condition"><Hint>Record the vehicle before departure and at return. Include exterior, interior and any damage. Your host performs a separate report. Do not include people, licenses or payment information in condition photos.</Hint>
    <Button title={phase === 'PRE_TRIP' ? 'Pre-trip selected — switch to return' : 'Return selected — switch to pre-trip'} onPress={() => setPhase(p => p === 'PRE_TRIP' ? 'POST_TRIP' : 'PRE_TRIP')} />
    <Field label="Odometer mileage" value={mileage} onChangeText={setMileage} keyboardType="number-pad" /><Field label="Fuel level (0–100 percent)" value={fuel} onChangeText={setFuel} keyboardType="number-pad" /><Field label="Damage notes" value={notes} onChangeText={setNotes} multiline maxLength={2000} />
    {(['EXTERIOR', 'INTERIOR', 'DAMAGE'] as const).map(category => <Upload key={category} label={category.toLowerCase() + ' condition photo'} kind="INSPECTION" reservationId={id} done={(_, uploadId) => setPhotos(p => [...p.filter(x => x.category !== category), { category, uploadId }])} />)}
    <Hint>Uploaded categories: {photos.map(p => p.category).join(', ') || 'None'}</Hint><ErrorText message={action.error} />
    <Button title="Submit condition report" disabled={action.busy || !photos.some(p => p.category === 'EXTERIOR') || !photos.some(p => p.category === 'INTERIOR') || !/^\d+$/.test(mileage) || !/^\d+$/.test(fuel) || Number(fuel) > 100} onPress={() => void action.run(async () => { await mutate('submitReport', { params: { id }, body: { phase, mileage: Number(mileage), fuelLevel: Number(fuel), damageNotes: notes, photos } }); await q.refetch(); })} />
    <Button title="Refresh saved reports" onPress={() => { void q.refetch(); }} />{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : q.data.items.map(r => <Card key={r.id}><Copy>{r.phase} · {r.submittedByRole}</Copy><Hint>{r.mileage} miles · {r.fuelLevel}% fuel</Hint><Copy>{r.damageNotes || 'No damage notes'}</Copy>{r.photos.map(p => <PrivatePhoto key={p.id} id={id} reportId={r.id} photoId={p.id} label={p.category} />)}{r.acceptedAt ? <Hint>Accepted {new Date(r.acceptedAt).toLocaleString()}</Hint> : r.submittedByRole === 'CUSTOMER' ? <Button title="Accept my report as accurate" disabled={action.busy} onPress={() => void action.run(async () => { await mutate('acceptReport', { params: { id, reportId: r.id }, body: {} }); await q.refetch(); })} /> : <Hint>The host must accept their own report.</Hint>}</Card>)}</Page>;
}
function PrivatePhoto({ id, reportId, photoId, label }: { id: string; reportId: string; photoId: string; label: string }) {
  const [uri, setUri] = useState<string | null>(null), action = useAction();
  return <><Button title={`View private ${label.toLowerCase()} photo`} disabled={action.busy} onPress={() => void action.run(async () => {
    const bytes = new Uint8Array(await session.call('reportPhoto', { params: { id, reportId, photoId } }));
    const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
    setUri(`data:${mime};base64,${fromByteArray(bytes)}`);
  })} />{uri && <Image alt={label} accessible accessibilityLabel={label + ' private condition photo'} source={{ uri }} style={{ width: '100%', height: 240 }} resizeMode="contain" />}<ErrorText message={action.error} /></>;
}
