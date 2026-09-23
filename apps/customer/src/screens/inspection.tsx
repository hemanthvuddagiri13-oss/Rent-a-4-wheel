import React, { useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { session, mutate, friendly } from '../runtime';
import { Page, Card, Copy, Hint, Button, Field, ErrorText, Busy } from '../ui';
import { Upload } from '../upload';
import { PrivateEvidence } from '../private-evidence';
import { useAction } from '../hooks';
export function Inspection({ route }: NativeStackScreenProps<Routes, 'Inspection'>) {
  usePreventScreenCapture();
  const { id } = route.params, action = useAction();
  const [phase, setPhase] = useState<'PRE_TRIP' | 'POST_TRIP'>('PRE_TRIP'), [mileage, setMileage] = useState(''), [fuel, setFuel] = useState(''), [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<Array<{ uploadId: string; category: 'EXTERIOR' | 'INTERIOR' | 'DAMAGE' }>>([]);
  const q = useQuery({ queryKey: ['reports', id], queryFn: ({ signal }) => session.call('reports', { params: { id } }, signal) });
  return <Page title="Vehicle condition"><Hint>Record the vehicle before departure and at return. Include exterior, interior and any damage. Each party performs and accepts their own report. Do not include people, licenses or payment information in condition photos.</Hint>
    <Button title={phase === 'PRE_TRIP' ? 'Pre-trip selected — switch to return' : 'Return selected — switch to pre-trip'} onPress={() => setPhase(p => p === 'PRE_TRIP' ? 'POST_TRIP' : 'PRE_TRIP')} />
    <Field label="Odometer mileage" value={mileage} onChangeText={setMileage} keyboardType="number-pad" /><Field label="Fuel level (0–100 percent)" value={fuel} onChangeText={setFuel} keyboardType="number-pad" /><Field label="Damage notes" value={notes} onChangeText={setNotes} multiline maxLength={2000} />
    {(['EXTERIOR', 'INTERIOR', 'DAMAGE'] as const).map(category => <Upload key={category} label={category.toLowerCase() + ' condition photo'} kind="INSPECTION" reservationId={id} done={(_, uploadId) => setPhotos(p => [...p.filter(x => x.category !== category), { category, uploadId }])} />)}
    <Hint>Uploaded categories: {photos.map(p => p.category).join(', ') || 'None'}</Hint><ErrorText message={action.error} />
    <Button title="Submit condition report" disabled={action.busy || !photos.some(p => p.category === 'EXTERIOR') || !photos.some(p => p.category === 'INTERIOR') || !/^\d+$/.test(mileage) || !/^\d+$/.test(fuel) || Number(fuel) > 100} onPress={() => void action.run(async () => { await mutate('submitReport', { params: { id }, body: { phase, mileage: Number(mileage), fuelLevel: Number(fuel), damageNotes: notes, photos } }); await q.refetch(); })} />
    <Button title="Refresh saved reports" onPress={() => { void q.refetch(); }} />{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : q.data.items.map(r => <Card key={r.id}><Copy>{r.phase} · {r.submittedByRole}</Copy><Hint>{r.mileage} miles · {r.fuelLevel}% fuel</Hint><Copy>{r.damageNotes || 'No damage notes'}</Copy>{r.photos.map(p => <PrivateEvidence key={p.id} report={{ id, reportId: r.id, photoId: p.id }} label={p.category + ' photo'} />)}{r.acceptedAt ? <Hint>Accepted {new Date(r.acceptedAt).toLocaleString()}</Hint> : r.own ? <Button title="Accept my report as accurate" disabled={action.busy} onPress={() => void action.run(async () => { await mutate('acceptReport', { params: { id, reportId: r.id }, body: {} }); await q.refetch(); })} /> : <Hint>Only the report�s author can accept it.</Hint>}</Card>)}</Page>;
}
