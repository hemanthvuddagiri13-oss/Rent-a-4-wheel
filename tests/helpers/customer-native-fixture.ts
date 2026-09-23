import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { fixtureJurisdiction } from './jurisdiction-fixture';
const db = new PrismaClient();
if (process.env.CI !== 'true' || !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) throw new Error('Disposable CI database only');
async function main() {
await fixtureJurisdiction(db);
const user = await db.user.create({ data: { email: 'native-customer@example.test', name: 'Synthetic customer', role: 'CUSTOMER' } });
// Delivery boundary fixture: the app still exercises the real issuance, bcrypt,
// consumption, native-session, refresh and logout HTTP routes. No production bypass.
for (let i = 0; i < 5; i++) await db.authCode.create({ data: { email: user.email, purpose: 'MOBILE_SIGN_IN', codeHash: await bcrypt.hash('123456', 4), createdAt: new Date(Date.now() - (5 - i) * 1000), expiresAt: new Date(Date.now() + 600000), consumedAt: i < 4 ? new Date() : null } });
const hostUser = await db.user.create({ data: { email: 'native-host@example.test', role: 'HOST' } });
const host = await db.hostProfile.create({ data: { userId: hostUser.id, legalName: 'Synthetic acceptance host', onboardingStatus: 'APPROVED', jurisdictionCode: 'TX' } });
const vehicle = await db.vehicle.create({ data: { slug: 'synthetic-native-car', vin: 'SYNTHETIC-NATIVE-ONLY', licensePlate: 'TESTONLY', make: 'Synthetic', model: 'Acceptance Car', year: 2025, category: 'SEDAN', hostId: host.id, jurisdictionCode: 'TX', dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000, listingApproval: 'APPROVED' } });
await db.reservation.create({ data: { confirmationNumber: 'NATIVE-SYNTHETIC-TRIP', customerId: user.id, vehicleId: vehicle.id, jurisdictionCode: 'TX', status: 'CONFIRMED', pickupAt: new Date('2057-01-01'), returnAt: new Date('2057-01-02'), rateType: 'DAILY', rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000 } });
await db.$disconnect();
}
void main().catch(async () => { await db.$disconnect(); process.exitCode = 1; });
