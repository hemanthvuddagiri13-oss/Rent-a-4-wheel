import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixtureJurisdiction } from './jurisdiction-fixture';
const db = new PrismaClient();
if (process.env.CI !== 'true' || !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) throw new Error('Disposable CI database only');
async function main() {
if (process.argv.includes('--assert')) {
  const customer = await db.user.findUniqueOrThrow({ where: { email: 'native-customer@example.test' } });
  const cases = await db.serviceCase.findMany({ where: { title: 'Synthetic native support request' }, include: { events: true } });
  if (cases.length !== 1 || cases[0].openedById !== customer.id || cases[0].kind !== 'TICKET' || cases[0].category !== 'GENERAL' || cases[0].reservationId !== null || cases[0].vehicleId !== null) throw new Error('Expected one correctly scoped standalone customer support case');
  const replies = await db.serviceCaseEvent.findMany({ where: { body: 'Synthetic follow-up.' } });
  if (replies.length !== 1 || replies[0].caseId !== cases[0].id || replies[0].actorId !== customer.id || replies[0].action !== 'CUSTOMER_REPLY' || cases[0].events.length !== 2) throw new Error('Expected one correctly authored customer reply and no duplicate case events');
  const messages = await db.conversationMessage.findMany({ where: { body: 'Synthetic native acceptance message' } });
  if (messages.length !== 1 || messages[0].senderId !== customer.id) throw new Error('Restart recovery must commit one correctly authored message');
  const reservation = await db.reservation.findUniqueOrThrow({ where: { confirmationNumber: 'NATIVE-SYNTHETIC-TRIP' } });
  if (reservation.status !== 'CANCELLED_BY_CUSTOMER') throw new Error('Restarted cancellation must remain terminal');
  if (await db.mobileMutation.count({ where: { userId: customer.id, operation: 'reservation.cancel' } }) !== 1) throw new Error('Restarted cancellation must use one durable receipt');
  const uploads = await db.mobileUpload.findMany({ where: { userId: customer.id } });
  if (uploads.length !== 1 || !uploads[0].finalizedAt || uploads[0].reservationId !== reservation.id) throw new Error('Restarted customer photo must finalize one original upload');
  if (await db.financialOperation.count() || await db.payoutItem.count()) throw new Error('Native recovery must not enable provider work');
  if (await db.conversationMessage.count({ where: { body: '<invalid>' } })) throw new Error('Rejected message must not create an effect');
  if (await db.mobileMutation.count({ where: { operation: 'message.send', result: { path: ['mobileRejectedV1', 'status'], equals: 400 } } }) !== 1) throw new Error('Expected one durable rejected message receipt');
  const signed = await db.agreementAcceptance.findMany({ where: { reservationId: reservation.id } });
  if (signed.length !== 1 || signed[0].contentSnapshot !== 'Synthetic frozen trial terms. No real rental agreement.') throw new Error('Private trial must preserve one frozen agreement');
  const document = await db.driverDocument.findFirstOrThrow({ where: { userId: customer.id, type: 'LICENSE_FRONT' } });
  if (await db.documentAccessLog.count({ where: { documentId: document.id, purpose: 'mobile_identity_preview' } }) < 3) throw new Error('Expected interrupted, corrected and restarted authorized private reads');
  console.log('Customer restart recovery: one scoped support case/reply, one message, one rejection receipt, zero provider operations and payouts.');
  await db.$disconnect(); return;
}
await fixtureJurisdiction(db);
await mkdir('/tmp/customer-native-fixtures', { recursive: true });
await writeFile('/tmp/customer-native-fixtures/condition.png', await sharp({ create: { width: 600, height: 400, channels: 3, background: '#243c54' } }).png().toBuffer());
const user = await db.user.create({ data: { email: 'native-customer@example.test', emailVerified: new Date(), name: 'Synthetic customer', role: 'CUSTOMER' } });
await db.mobilePhoneIdentity.create({ data: { userId: user.id, phone: '+12025550101' } });
// Code-verification fixture, NOT email issuance/delivery coverage. Four consumed
// rows plus one usable code trigger the request endpoint's generic rate-limit
// response. The app consumes this pre-seeded code through real bcrypt/session
// routes; it does not capture or consume a newly delivered email code.
for (let i = 0; i < 5; i++) await db.authCode.create({ data: { email: user.email, purpose: 'MOBILE_SIGN_IN', codeHash: await bcrypt.hash('123456', 4), createdAt: new Date(Date.now() - (5 - i) * 1000), expiresAt: new Date(Date.now() + 600000), consumedAt: i < 4 ? new Date() : null } });
const hostUser = await db.user.create({ data: { email: 'native-host@example.test', role: 'HOST' } });
const host = await db.hostProfile.create({ data: { userId: hostUser.id, legalName: 'Synthetic acceptance host', onboardingStatus: 'APPROVED', jurisdictionCode: 'TX' } });
const vehicle = await db.vehicle.create({ data: { slug: 'synthetic-native-car', vin: 'SYNTHETIC-NATIVE-ONLY', licensePlate: 'TESTONLY', make: 'Synthetic', model: 'Acceptance Car', year: 2025, category: 'SEDAN', hostId: host.id, jurisdictionCode: 'TX', dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000, listingApproval: 'APPROVED' } });
const trialReservation = await db.reservation.create({ data: { confirmationNumber: 'NATIVE-SYNTHETIC-TRIP', customerId: user.id, vehicleId: vehicle.id, jurisdictionCode: 'TX', status: 'CONFIRMED', pickupAt: new Date('2057-01-01'), returnAt: new Date('2057-01-02'), rateType: 'DAILY', rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000 } });
const contentSnapshot = 'Synthetic frozen trial terms. No real rental agreement.';
await db.agreementAcceptance.create({ data: { reservationId: trialReservation.id, signedByUserId: user.id, signerName: 'Synthetic customer', type: 'RENTAL_AGREEMENT', documentVersion: 'FIXTURE-NOT-LEGAL', contentSnapshot, contentHash: createHash('sha256').update(contentSnapshot).digest('hex') } });
const identityBytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#243c54' } }).png().toBuffer();
await mkdir('private-storage/documents', { recursive: true }); await writeFile('private-storage/documents/customer-synthetic.png', identityBytes);
const storageKey = 'local:customer-synthetic.png', hash = createHash('sha256').update(identityBytes).digest('hex');
await db.privateObject.create({ data: { key: storageKey, sha256: hash, size: identityBytes.length, mimeType: 'image/png', state: 'CLEAN', writeState: 'STORED' } });
await db.driverDocument.create({ data: { userId: user.id, reservationId: trialReservation.id, type: 'LICENSE_FRONT', storageKey, mimeType: 'image/png', fileSizeBytes: identityBytes.length, contentSha256: hash, malwareScanStatus: 'CLEAN', retentionExpiresAt: new Date('2058-01-01') } });
await db.$disconnect();
}
void main().catch(async () => { await db.$disconnect(); process.exitCode = 1; });
