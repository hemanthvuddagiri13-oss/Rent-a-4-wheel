import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { withReservationLock } from "@/lib/financial-locks";
import { transitionReservation } from "@/lib/reservation-state-machine";
import type { ReservationStatus } from "@prisma/client";

// The chain a reservation walks through, one legal transition at a time,
// once every trip-start precondition is independently satisfied and
// audited (document approval, identity handoff, condition-report
// acceptance by both parties, agreement signature, pickup window). Each
// intermediate status has no additional gate of its own in this phase —
// they exist in the state machine so the lifecycle is fully modeled and
// auditable, and a future phase can add per-step UI/endpoints without a
// schema change.
const PRE_TRIP_CHAIN: ReservationStatus[] = [
  "DOCUMENTS_REQUIRED",
  "READY_FOR_CHECK_IN",
  "CHECK_IN_PROGRESS",
  "READY_TO_START",
  "ACTIVE",
];

/**
 * Starts the trip: only the customer on the reservation may call this
 * (the host cannot start it alone — see README "Trip-Start Rule"), and
 * only once every precondition in evaluateTripStartGate() passes.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Only the customer on this reservation can start the trip." }, { status: 403 });
  }

  const gate = await evaluateTripStartGate(id);
  if (!gate.canStart) {
    return NextResponse.json({ error: "Trip cannot start yet.", reasons: gate.reasons }, { status: 409 });
  }

  const startIndex = PRE_TRIP_CHAIN.indexOf(reservation.status);
  if (startIndex === -1 || startIndex === PRE_TRIP_CHAIN.length - 1) {
    return NextResponse.json({ error: `Reservation is not in a pre-trip status (currently ${reservation.status}).` }, { status: 409 });
  }

  const preTripReport = await prisma.conditionReport.findFirst({
    where: { reservationId: id, phase: "PRE_TRIP", submittedByRole: "HOST" },
  });

  try {
    await withReservationLock(id, async (tx) => {
      const freshGate = await evaluateTripStartGate(id, tx);
      if (!freshGate.canStart) throw new Error(freshGate.reasons.join("; "));
      let current = reservation.status;
      for (let i = startIndex; i < PRE_TRIP_CHAIN.length - 1; i++) {
        const next = PRE_TRIP_CHAIN[i + 1]!;
        await transitionReservation(tx, { id, from: current, to: next });
        current = next;
      }

      await tx.trip.upsert({
        where: { reservationId: id },
        create: {
          reservationId: id,
          startedAt: new Date(),
          startedByUserId: session.user.id,
          startMileage: preTripReport?.mileage,
          startFuelLevel: preTripReport?.fuelLevel,
        },
        update: {
          startedAt: new Date(),
          startedByUserId: session.user.id,
          startMileage: preTripReport?.mileage,
          startFuelLevel: preTripReport?.fuelLevel,
        },
      });

      await tx.tripEvent.create({ data: { reservationId: id, type: "TRIP_STARTED", actorId: session.user.id } });
    });
  } catch (err) {
    console.error("Failed to start trip", err);
    return NextResponse.json({ error: "Something went wrong starting the trip. Please try again." }, { status: 409 });
  }

  return NextResponse.json({ success: true });
}
