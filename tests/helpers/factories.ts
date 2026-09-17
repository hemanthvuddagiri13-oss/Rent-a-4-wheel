import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

let counter = 0;
function unique() {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export async function createTestVehicle(overrides: Partial<Parameters<typeof prisma.vehicle.create>[0]["data"]> = {}) {
  const id = unique();
  return prisma.vehicle.create({
    data: {
      slug: `test-vehicle-${id}`,
      vin: `V${id}`.toUpperCase(),
      licensePlate: `T${id}`.toUpperCase(),
      year: 2024,
      make: "TestMake",
      model: "TestModel",
      category: "SEDAN",
      dailyRateCents: 5000,
      weeklyRateCents: 30000,
      monthlyRateCents: 90000,
      securityDepositCents: 30000,
      status: "ACTIVE",
      ...overrides,
    },
  });
}

export async function createTestCustomer(overrides: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  return prisma.user.create({
    data: { email: `test-user-${unique()}@example.com`, role: "CUSTOMER", ...overrides },
  });
}

export async function createTestHost() {
  const user = await prisma.user.create({
    data: { email: `test-host-${unique()}@example.com`, role: "HOST" },
  });
  const hostProfile = await prisma.hostProfile.create({
    data: { userId: user.id, legalName: "Test Host LLC", onboardingStatus: "APPROVED" },
  });
  return { user, hostProfile };
}

const BASE_RESERVATION_FIELDS = {
  rateType: "DAILY" as const,
  rateAmountCents: 5000,
  units: 3,
  subtotalCents: 15000,
  totalCents: 15000,
};

export async function createTestReservation(params: {
  vehicleId: string;
  customerId: string;
  pickupAt: Date;
  returnAt: Date;
  status?: Parameters<typeof prisma.reservation.create>[0]["data"]["status"];
  expiresAt?: Date | null;
  depositCents?: number;
}) {
  const reservation = await prisma.reservation.create({
    data: {
      confirmationNumber: `RA4W-T${unique()}`.toUpperCase(),
      customerId: params.customerId,
      vehicleId: params.vehicleId,
      pickupAt: params.pickupAt,
      returnAt: params.returnAt,
      status: params.status ?? "CHECKOUT_HOLD",
      expiresAt: params.expiresAt,
      depositCents: params.depositCents ?? 0,
      ...BASE_RESERVATION_FIELDS,
    },
  });
  return reservation;
}

export function uniqueEmail(prefix: string) {
  return `${prefix}-${unique()}@example.com`;
}

/**
 * Deletes every row that references a reservation (in FK dependency order)
 * before deleting the reservations themselves — several tables RESTRICT
 * deletes of their parent reservation, so this must run before
 * `prisma.reservation.deleteMany()` in test teardown.
 */
export async function cleanupReservationsForVehicles(vehicleIds: string[]) {
  if (vehicleIds.length === 0) return;
  const reservations = await prisma.reservation.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } });
  const reservationIds = reservations.map((r) => r.id);
  await prisma.bookingDraft.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  if (reservationIds.length === 0) return;
  await prisma.financialCase.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.financialOperation.deleteMany({ where: { reservationId: { in: reservationIds } } });
  for (const reservationId of reservationIds) await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["reservationId"], equals: reservationId } } });
  await prisma.notification.deleteMany({ where: { reservationId: { in: reservationIds } } });

  await prisma.emergencyOverrideRecord.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.paymentReconciliation.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.tripEvent.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.tripChecklist.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.conditionPhoto.deleteMany({ where: { conditionReport: { reservationId: { in: reservationIds } } } });
  await prisma.conditionReport.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.identityHandoffVerification.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.agreementAcceptance.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.trip.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.documentAccessLog.deleteMany({ where: { document: { reservationId: { in: reservationIds } } } });
  await prisma.driverDocument.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.refund.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.payment.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.securityDeposit.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
}
