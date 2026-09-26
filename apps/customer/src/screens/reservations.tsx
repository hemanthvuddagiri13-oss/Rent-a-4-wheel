import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Routes } from '../navigation';
import { session, mutate, friendly, type Output } from '../runtime';
import { Page, Card, Copy, Hint, Button, Busy, ErrorText, money } from '../ui';
import { useAction } from '../hooks';
export function Reservations({ navigation }: NativeStackScreenProps<Routes, 'Reservations'>) {
  const [cursor, setCursor] = useState<string | undefined>();
  const q = useQuery({ queryKey: ['reservations', cursor], queryFn: ({ signal }) => session.call('reservations', { query: { cursor } }, signal) });
  return <Page title="Your trips"><Button title="Refresh trips" onPress={() => { void q.refetch(); }} />{q.isPending ? <Busy /> : q.isError ? <ErrorText message={friendly(q.error)} /> : <>{!q.data.items.length && <Hint>No reservations yet. Explore vehicles to plan your next trip.</Hint>}{q.data.items.map(r => <Card key={r.id}><Copy>{r.confirmationNumber}</Copy><Hint>{`Pickup: ${new Date(r.pickupAt).toLocaleString()}`}</Hint><Hint>{`Return: ${new Date(r.returnAt).toLocaleString()}`}</Hint><Hint>{r.status === 'CONFIRMED' ? 'Open trip to verify payment and deposit.' : r.status.replaceAll('_', ' ')}</Hint><Button title={`View trip ${r.confirmationNumber}`} onPress={() => navigation.navigate('Reservation', { id: r.id })} /></Card>)}{q.data.nextCursor && <Button title="More trips" onPress={() => setCursor(q.data.nextCursor ?? undefined)} />}</>}</Page>;
}
export function FinancialStatus({ value: p }: { value: Output<'paymentStatus'> }) {
  const confirmed = p.outcome === 'confirmed';
  return <Card><Copy>{confirmed ? 'Reservation confirmed by server' : 'Reservation is not financially confirmed'}</Copy><Hint>Payment: {p.rentalPaymentStatus ?? 'Not received'} · Deposit: {p.depositStatus ?? 'Not authorized'}</Hint><Copy>Paid {money(p.paidCents)} · Refunded {money(p.refundedCents)}</Copy><Hint>{p.outcome} · {p.refundStatus}. Trip start has additional verification and handoff requirements.</Hint></Card>;
}
export function Pricing({ value: p }: { value: Output<'pricing'> }) { return <Card><Copy>Server price breakdown</Copy>{([['Vehicle', p.subtotalCents], ['Extras', p.extrasCents], ['Discount', -p.discountCents], ['Platform fee', p.platformFeeCents], ['Protection', p.protectionCents], ['Payment processing', p.processingCents], ['Taxes', p.taxCents], ['Total', p.totalCents], ['Separate deposit', p.depositCents]] as const).map(([label, cents]) => <Copy key={label}>{label}: {money(cents)}</Copy>)}<Hint>Policy status: SAMPLE / UNAPPROVED. Unknown historical components are shown as unavailable.</Hint></Card>; }
export function Reservation({ navigation, route }: NativeStackScreenProps<Routes, 'Reservation'>) {
  const { id } = route.params, action = useAction();
  const r = useQuery({ queryKey: ['reservation', id], queryFn: ({ signal }) => session.call('reservation', { params: { id } }, signal) });
  const payment = useQuery({ queryKey: ['payment', id], queryFn: ({ signal }) => session.call('paymentStatus', { params: { id } }, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const pricing = useQuery({ queryKey: ['pricing', id], queryFn: ({ signal }) => session.call('pricing', { params: { id } }, signal) });
  const trip = useQuery({ queryKey: ['trip', id], queryFn: ({ signal }) => session.call('trip', { params: { id } }, signal) });
  const refresh = async () => { await Promise.all([r.refetch(), payment.refetch(), pricing.refetch(), trip.refetch()]); };
  // Settle the initial sections before exposing actions: late price/gate content
  // must not move a button underneath a customer's finger after process restart.
  if ([r, payment, pricing, trip].some(q => q.isPending)) return <Page title="Loading your reservation"><Busy /></Page>;
  return <Page titleTestID="reservation-loaded" title={r.data?.confirmationNumber ?? 'Your reservation'}><Button title="Refresh reservation status" onPress={() => void refresh()} />{[r, payment, pricing, trip].filter(q => q.isError).map((q, i) => <ErrorText key={i} message={friendly(q.error)} />)}
    {r.data && <><Hint>{`Pickup: ${new Date(r.data.pickupAt).toLocaleString()}`}</Hint><Hint>{`Return: ${new Date(r.data.returnAt).toLocaleString()}`}</Hint>{r.data.expiresAt && <Hint>{`Hold deadline: ${new Date(r.data.expiresAt).toLocaleString()}`}</Hint>}</>}
    {r.data && <Hint>Pickup location: {r.data.pickupLocation}</Hint>}
    {payment.data && !payment.isError && <FinancialStatus value={payment.data} />}{pricing.data && <Pricing value={pricing.data} />}
    <Card><Copy>Payment and deposit completion unavailable in this app</Copy><Hint>No secure web-session handoff has been approved. Preparing checkout does not pay or confirm a reservation. Live payments remain disabled.</Hint></Card>
    {r.data && ['CHECKOUT_HOLD', 'AWAITING_PAYMENT'].includes(r.data.status) && <Button title="Documents & checkout preparation" onPress={() => navigation.navigate('Checkout', { id })} />}
    <Card><Copy>Before your trip</Copy><Hint>Coordinate pickup with your independent host in Messages. Bring your valid license. Complete document review, physical identity handoff, condition reports and key handoff. The host stores, maintains and hands over the vehicle.</Hint>{trip.data?.gate.reasons.map(reason => <Hint key={reason}>{reason}</Hint>)}<Button title="Condition photos & reports" onPress={() => navigation.navigate('Inspection', { id })} /><Button title="Start trip" disabled={action.busy || !trip.data?.gate.canStart || trip.isError} onPress={() => void action.run(async () => { await mutate('tripStart', { params: { id }, body: {} }); await refresh(); })} /></Card>
    <ErrorText message={action.error} /><Button title="Message your host" disabled={action.busy} onPress={() => void action.run(async () => { const c = await mutate('openConversation', { body: { reservationId: id } }); navigation.navigate('Messages', { id: c.id }); })} />
    <Button title="Get help with this trip" onPress={() => navigation.navigate('Cases', { reservationId: id })} />
    {r.data?.status === 'ACTIVE' && <Button title="Begin vehicle return" disabled={action.busy} onPress={() => void action.run(async () => { await mutate('tripReturn', { params: { id }, body: {} }); await refresh(); })} />}
    {['COMPLETED', 'CLOSED'].includes(r.data?.status ?? '') && <Button title="Review this trip" onPress={() => navigation.navigate('Review', { id })} />}
    {['CHECKOUT_HOLD', 'AWAITING_PAYMENT', 'CONFIRMED'].includes(r.data?.status ?? '') && <Button title="Cancel reservation" disabled={action.busy} onPress={() => void action.run(async () => { await mutate('tripCancel', { params: { id }, body: {} }); await refresh(); })} />}
  </Page>;
}
