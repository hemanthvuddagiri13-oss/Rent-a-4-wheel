import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fixtureJurisdiction } from './jurisdiction-fixture';
const db = new PrismaClient();
if (process.env.CI !== 'true' || !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) throw new Error('Disposable CI database only');
async function assertIncident(expected = 1) {
  const owner = await db.user.findUniqueOrThrow({ where: { email: 'host-owner@example.test' } });
  const reservation = await db.reservation.findUniqueOrThrow({ where: { confirmationNumber: 'HOST-READY' } });
  const cases = await db.serviceCase.findMany({ where: { title: 'Synthetic lost spare key' }, include: { events: true } });
  if (cases.length !== expected) throw new Error('Incident count: expected ' + expected + ', got ' + cases.length);
  for (const c of cases) {
    if (c.kind !== 'INCIDENT' || c.category !== 'LOST_KEY' || c.reservationId !== reservation.id || c.vehicleId !== reservation.vehicleId || c.openedById !== owner.id || c.state !== 'REPORTED') throw new Error('Incident scope or authoritative state mismatch');
    if (c.events.length !== 1 || c.events[0].actorId !== owner.id || c.events[0].body !== 'Synthetic incident for host acceptance only.') throw new Error('Incident must have exactly one correctly authored opening event');
  }
  console.log('Incident database assertion: ' + expected + ' correctly scoped incident(s), no duplicate opening events.');
}
async function main() {
  if (process.argv.includes('--assert-incident')) { await assertIncident(); return; }
  if (process.argv.includes('--assert-no-incident')) { await assertIncident(0); return; }
  if (process.argv.includes('--revoke')) {
    const user = await db.user.findUniqueOrThrow({ where: { email: 'host-employee@example.test' } });
    await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${user.id} FOR UPDATE`; await tx.hostEmployee.deleteMany({ where: { userId: user.id } }); });
    return;
  }
  if (process.argv.includes('--assert')) {
    await assertIncident();
    const reply = await db.serviceCaseEvent.count({ where: { body: 'Synthetic interrupted reply.' } });
    if (reply !== 1) throw new Error('Interrupted reply must commit exactly once');
    if (await db.conversationMessage.count({ where: { body: 'Synthetic host pickup instructions.' } }) !== 1) throw new Error('Restarted message must commit exactly once');
    const handoffs = await db.identityHandoffVerification.count({ where: { reservation: { confirmationNumber: 'HOST-PICKUP' }, verifiedAt: { not: null } } });
    if (handoffs !== 1) throw new Error('Host handoff missing');
    const r = await db.reservation.findUniqueOrThrow({ where: { confirmationNumber: 'HOST-PICKUP' } });
    if (r.status !== 'CONFIRMED' || await db.tripChecklist.count({ where: { reservationId: r.id } })) throw new Error('Blocked gates were bypassed');
    const completed = await db.reservation.findUniqueOrThrow({ where: { confirmationNumber: 'HOST-RETURN' } });
    if (completed.status !== 'COMPLETED') throw new Error('Return journey did not complete');
    if (await db.mobileMutation.count({ where: { operation: 'reservation.return' } }) !== 1) throw new Error('Interrupted return must use one durable receipt');
    const owner = await db.user.findUniqueOrThrow({ where: { email: 'host-owner@example.test' } });
    const uploads = await db.mobileUpload.findMany({ where: { userId: owner.id } });
    if (uploads.length !== 4 || uploads.some(upload => !upload.finalizedAt) || uploads.filter(upload => upload.reservationId === completed.id).length !== 2) throw new Error('Restarted uploads must finalize exactly four original host intents, two per report');
    const ready = await db.reservation.findUniqueOrThrow({ where: { confirmationNumber: 'HOST-READY' } });
    if (ready.status !== 'CONFIRMED' || await db.tripChecklist.count({ where: { reservationId: ready.id, step: 'KEYS_RELEASED' } }) !== 1 || await db.trip.count({ where: { reservationId: ready.id } })) throw new Error('Keys must not start the guest trip');
    if (await db.tripEvent.count({ where: { reservationId: ready.id, type: 'TRIP_KEYS' } }) !== 1) throw new Error('Repeated keys taps must commit once');
    for (const type of ['TRIP_COMPLETE', 'RETURN_REVIEWED']) if (await db.tripEvent.count({ where: { reservationId: completed.id, type } }) !== 1) throw new Error('Repeated completion taps must commit once');
    if (await db.financialOperation.count() || await db.payoutItem.count()) throw new Error('Native acceptance must not issue provider work');
    console.log('Native database assertions: one reply, one handoff, blocked start/keys, completed return, zero provider operations/payouts.');
    return;
  }
  await fixtureJurisdiction(db);
  const owner = await db.user.create({ data: { email: 'host-owner@example.test', emailVerified: new Date(), name: 'Synthetic owner', role: 'HOST' } });
  const host = await db.hostProfile.create({ data: { userId: owner.id, legalName: 'Synthetic host business', onboardingStatus: 'APPROVED', jurisdictionCode: 'TX' } });
  const employee = await db.user.create({ data: { email: 'host-employee@example.test', emailVerified: new Date(), name: 'Synthetic employee', role: 'HOST_EMPLOYEE' } });
  await db.hostEmployee.create({ data: { userId: employee.id, hostId: host.id, role: 'STAFF' } });
  const other = await db.user.create({ data: { email: 'host-other@example.test', emailVerified: new Date(), role: 'HOST' } });
  await db.hostProfile.create({ data: { userId: other.id, legalName: 'Unrelated synthetic host', onboardingStatus: 'APPROVED', jurisdictionCode: 'TX' } });
  for (const [index, user] of [owner, employee, other].entries()) await db.mobilePhoneIdentity.create({ data: { userId: user.id, phone: '+1202555010' + (index + 2) } });
  const guest = await db.user.create({ data: { email: 'host-guest@example.test', emailVerified: new Date(), name: 'Synthetic guest', role: 'CUSTOMER' } });
  const vehicle = await db.vehicle.create({ data: { slug: 'host-synthetic-car', vin: 'HOST-SYNTHETIC-ONLY', licensePlate: 'HOSTTEST', make: 'Synthetic', model: 'Host Car', year: 2025, category: 'SEDAN', hostId: host.id, jurisdictionCode: 'TX', dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000, listingApproval: 'APPROVED', isDemo: true, description: 'Synthetic vehicle for installed app acceptance only.', rules: 'Synthetic fixture. No real booking or vehicle.' } });
  const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#243c54' } }).png().toBuffer();
  await mkdir('private-storage/documents', { recursive: true }); await writeFile('private-storage/documents/host-synthetic.png', bytes);
  // Synthetic color tile, never an actual identity document or vehicle photo.
  await mkdir('/tmp/host-native-fixtures', { recursive: true }); await writeFile('/tmp/host-native-fixtures/condition.png', bytes);
  await writeFile('/tmp/host-native-fixtures/interior.png', await sharp({ create: { width: 600, height: 400, channels: 3, background: '#543c24' } }).png().toBuffer());
  const key = 'local:host-synthetic.png';
  await db.privateObject.create({ data: { key, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mimeType: 'image/png', state: 'CLEAN', writeState: 'STORED' } });
  for (const [index, confirmationNumber] of ['HOST-PICKUP', 'HOST-RETURN', 'HOST-READY'].entries()) {
    const r = await db.reservation.create({ data: { id: 'host-native-' + index, confirmationNumber, customerId: guest.id, vehicleId: vehicle.id, jurisdictionCode: 'TX', status: index === 1 ? 'ACTIVE' : 'CONFIRMED', pickupAt: index === 2 ? new Date() : new Date(index ? '2057-02-01' : '2057-01-01'), returnAt: index === 2 ? new Date(Date.now() + 12 * 3600000) : new Date(index ? '2057-02-02' : '2057-01-02'), rateType: 'DAILY', rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000, depositCents: 0, pickupLocation: 'Synthetic pickup bay A. Compare identity in person.' } });
    if (index !== 1) for (const type of ['LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE'] as const) await db.driverDocument.create({ data: { userId: guest.id, reservationId: r.id, type, storageKey: key, mimeType: 'image/png', fileSizeBytes: bytes.length, contentSha256: createHash('sha256').update(bytes).digest('hex'), malwareScanStatus: 'CLEAN', status: 'APPROVED', retentionExpiresAt: new Date('2058-01-01') } });
    if (index === 2) {
      await db.payment.create({ data: { reservationId: r.id, type: 'RENTAL', amountCents: 10000, currency: 'usd', status: 'SUCCEEDED' } });
      await db.agreementAcceptance.create({ data: { reservationId: r.id, type: 'RENTAL_AGREEMENT', signedByUserId: guest.id, signerName: 'Synthetic guest', documentVersion: 'FIXTURE-NOT-LEGAL', contentSnapshot: 'Synthetic acceptance only', contentHash: createHash('sha256').update('Synthetic acceptance only').digest('hex') } });
      await db.identityHandoffVerification.create({ data: { reservationId: r.id, verifiedByHostId: owner.id, licenseMatchesUpload: true, physicalLicenseUnexpired: true, selfieMatchesCustomer: true, verifiedAt: new Date() } });
      await db.conditionReport.create({ data: { reservationId: r.id, phase: 'PRE_TRIP', submittedByRole: 'CUSTOMER', submittedById: guest.id, mileage: 100, fuelLevel: 50, acceptedAt: new Date(), photos: { create: [{ category: 'EXTERIOR', storageKey: key }, { category: 'INTERIOR', storageKey: key }] } } });
    }
    if (index === 1) {
      await db.trip.create({ data: { reservationId: r.id, startedAt: new Date(), startMileage: 100, startFuelLevel: 50, startedByUserId: guest.id } });
      await db.payment.create({ data: { reservationId: r.id, type: 'RENTAL', amountCents: 10000, currency: 'usd', status: 'SUCCEEDED' } });
      // Guest return actions are independent fixture evidence, never performed by
      // a host button. Host creates and accepts their own report in the app.
      await db.conditionReport.create({ data: { reservationId: r.id, phase: 'POST_TRIP', submittedByRole: 'CUSTOMER', submittedById: guest.id, mileage: 120, fuelLevel: 50, acceptedAt: new Date(), photos: { create: [{ category: 'EXTERIOR', storageKey: key }, { category: 'INTERIOR', storageKey: key }] } } });
    }
  }
}
void main().finally(() => db.$disconnect());

