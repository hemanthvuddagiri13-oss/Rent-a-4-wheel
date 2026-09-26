import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixtureJurisdiction } from './jurisdiction-fixture';
const db = new PrismaClient();
if (process.env.CI !== 'true' || !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) throw new Error('Disposable CI database only');
async function main() {
if (process.argv.includes('--assert')) {
  const customer = await db.user.findUniqueOrThrow({ where: { email: 'native-customer@example.test' } });
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
  console.log('Customer restart recovery: one message, one rejection receipt, zero provider operations and payouts.');
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
await db.reservation.create({ data: { confirmationNumber: 'NATIVE-SYNTHETIC-TRIP', customerId: user.id, vehicleId: vehicle.id, jurisdictionCode: 'TX', status: 'CONFIRMED', pickupAt: new Date('2057-01-01'), returnAt: new Date('2057-01-02'), rateType: 'DAILY', rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000 } });
await db.$disconnect();
}
void main().catch(async () => { await db.$disconnect(); process.exitCode = 1; });
