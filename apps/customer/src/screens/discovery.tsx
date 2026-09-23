import React, { useState } from 'react';
import { Image, Platform, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { publicApi, origin, session, mutate, intentKey, friendly, type Output } from '../runtime';
import { Page, Card, Copy, Hint, Button, Busy, ErrorText, money } from '../ui';
import { useAction } from '../hooks';

function wholeMinute(value: Date) { const result = new Date(value); result.setSeconds(0, 0); return result; }

export function Home({ navigation }: NativeStackScreenProps<Routes, 'Home'>) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery({ queryKey: ['vehicles', cursor], queryFn: ({ signal }) => publicApi.call('vehicles', { query: { limit: 12, cursor } }, signal) });
  return <Page title="Your next drive starts here."><Hint>Independent hosts. Clear pricing. More room to explore.</Hint>
    <Card><Copy>Staging preview · Live payments unavailable</Copy><Hint>Availability and eligibility are always checked by the server. No booking is confirmed by this app alone.</Hint></Card>
    <View style={{ gap: 10 }}>{(['SignIn', 'Reservations', 'Inbox', 'Notices', 'Cases', 'Account'] as const).map((screen, i) => <Button key={screen} title={['Sign in', 'Your trips', 'Messages', 'Notices', 'Support & cases', 'Account & devices'][i]} onPress={() => navigation.navigate(screen)} />)}</View>
    {query.isPending ? <Busy /> : query.isError ? <><ErrorText message={friendly(query.error)} /><Button title="Retry discovery" onPress={() => { void query.refetch(); }} /></> : <>
      {!query.data.items.length && <Card><Copy>No vehicles are available in the current launch markets.</Copy><Hint>Check back when your region opens. Demo inventory is not bookable.</Hint></Card>}
      {query.data.items.map(v => <VehicleCard key={v.id} vehicle={v} open={() => navigation.navigate('Vehicle', { id: v.id })} />)}
      {query.data.nextCursor && <Button title="Next vehicles" onPress={() => setCursor(query.data.nextCursor ?? undefined)} />}
      {cursor && <Button title="Back to first vehicles" onPress={() => setCursor(undefined)} />}
    </>}</Page>;
}
function ListingPhoto({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['listingPhotos', id], queryFn: ({ signal }) => publicApi.call('listingPhotos', { params: { id } }, signal) });
  const [failed, setFailed] = useState(false), p = q.data?.items[0];
  return p && !failed ? <Image alt={p.alt} accessible accessibilityLabel={p.alt} source={{ uri: origin + p.path }} onError={() => setFailed(true)} style={{ width: '100%', height: 200, borderRadius: 12 }} resizeMode="cover" /> : <Hint>Listing photo not available</Hint>;
}
function VehicleCard({ vehicle: v, open }: { vehicle: Output<'vehicle'>; open?: () => void }) { return <Card><ListingPhoto id={v.id} /><Copy>{v.year} {v.make} {v.model}</Copy><Hint>{v.location} · {v.seats} seats · {v.transmission}</Hint><Copy>From {money(v.dailyRateCents)} / day</Copy><Hint>Final fees, protection and taxes appear in your server quote.</Hint>{open && <Button title={`View ${v.make} ${v.model}`} onPress={open} />}</Card>; }
export function Vehicle({ navigation, route }: NativeStackScreenProps<Routes, 'Vehicle'>) {
  const { id } = route.params, q = useQuery({ queryKey: ['vehicle', id], queryFn: ({ signal }) => publicApi.call('vehicle', { params: { id } }, signal) });
  const [pickup, setPickup] = useState(() => wholeMinute(new Date(Date.now() + 86400000))), [end, setEnd] = useState(() => wholeMinute(new Date(Date.now() + 172800000)));
  const [checked, setChecked] = useState<{ pickupAt: string; returnAt: string; available: boolean } | null>(null), action = useAction();
  const dates = { pickupAt: pickup.toISOString(), returnAt: end.toISOString() };
  const available = checked?.pickupAt === dates.pickupAt && checked.returnAt === dates.returnAt ? checked.available : null;
  return <Page title={q.data ? `${q.data.make} ${q.data.model}` : 'Vehicle details'}>{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : <><VehicleCard vehicle={q.data} /><Hint>{q.data.fuelType} · Deposit {money(q.data.securityDepositCents)}</Hint></>}
    <Hint>Dates and times use your device timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). The server receives exact instants.</Hint>
    <DateField title="Pickup" value={pickup} onChange={d => { setPickup(wholeMinute(d)); setChecked(null); }} />
    <DateField title="Return" value={end} onChange={d => { setEnd(wholeMinute(d)); setChecked(null); }} />
    <ErrorText message={action.error} />
    <Button title="Check availability" disabled={action.busy || !q.data} onPress={() => void action.run(async () => { const result = await publicApi.call('availability', { params: { id }, body: dates }); setChecked({ ...dates, available: result.available }); })} />
    {available !== null && <Copy>{available ? 'Available at last check. A hold is required to reserve these dates.' : 'These dates are unavailable. Choose another time.'}</Copy>}
    <Button title="Hold dates & review price" disabled={action.busy || available !== true} onPress={() => void action.run(async () => {
      await session.token(); const me = await session.call('me', {});
      const draftId = await intentKey(me.id + ':holdDraft', { id, ...dates });
      const result = await mutate('hold', { body: { vehicleId: id, ...dates, draftId, revision: 1, extraIds: [] } }); navigation.navigate('Reservation', { id: result.id });
    })} /><Hint>Sign in before placing a hold. Availability can change until the hold succeeds.</Hint></Page>;
}
function DateField({ title, value, onChange }: { title: string; value: Date; onChange: (d: Date) => void }) {
  const [mode, setMode] = useState<'date' | 'time' | null>(null);
  return <Card><Copy>{title}: {value.toLocaleString()}</Copy><Button title={`Choose ${title.toLowerCase()} date`} onPress={() => setMode('date')} /><Button title={`Choose ${title.toLowerCase()} time`} onPress={() => setMode('time')} />{mode && <><DateTimePicker accessibilityLabel={title + ' ' + mode} value={value} mode={mode} minimumDate={mode === 'date' ? new Date() : undefined} themeVariant="dark" onChange={(_, d) => { if (Platform.OS === 'android') setMode(null); if (d) onChange(d); }} />{Platform.OS === 'ios' && <Button title="Done choosing date" onPress={() => setMode(null)} />}</>}</Card>;
}
