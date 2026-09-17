import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import {
  bookingConfirmationEmail,
  cancellationEmail,
  depositAuthFailedEmail,
  lateReturnEmail,
  paymentReceiptEmail,
  pickupReminderEmail,
  refundEmail,
  returnReminderEmail,
  tripEmergencyOverrideEmail,
  upcomingRentalReminderEmail,
} from "@/lib/email-templates";
import type { NotificationType } from "@prisma/client";

interface QueueNotificationParams {
  deliveryKey?: string;
  deferProjection?: boolean;
  throwOnFailure?: boolean;
  userId?: string;
  reservationId?: string;
  type: NotificationType;
  extra?: Record<string, unknown>;
}

const SUBJECTS: Record<NotificationType, string> = {
  COMMUNITY_UPDATE: "An update is waiting in your Rent A 4Wheel account",
  BOOKING_CONFIRMATION: "Your Rent A 4Wheel reservation is confirmed",
  PAYMENT_RECEIPT: "Your Rent A 4Wheel payment receipt",
  DEPOSIT_AUTH_FAILED: "Action needed: security deposit could not be authorized",
  TRIP_EMERGENCY_OVERRIDE: "A staff action was taken on your trip",
  UPCOMING_RENTAL_REMINDER: "Your Rent A 4Wheel rental is coming up",
  DRIVER_VERIFICATION_REQUEST: "Action needed: verify your driver information",
  PICKUP_REMINDER: "Pickup reminder — Rent A 4Wheel",
  RETURN_REMINDER: "Return reminder — Rent A 4Wheel",
  CANCELLATION: "Your reservation has been cancelled",
  REFUND: "Your refund has been processed",
  LATE_RETURN: "Late return notice",
};

export async function queueNotification({ userId, reservationId, type, extra, deliveryKey, throwOnFailure, deferProjection }: QueueNotificationParams) {
  const create = { userId, reservationId, type, channel: "EMAIL" as const, status: "PENDING" as const, subject: SUBJECTS[type] };
  const notification = deliveryKey
    ? await prisma.notification.upsert({ where: { deliveryKey }, update: {}, create: { ...create, deliveryKey } })
    : await prisma.notification.create({ data: create });
  if (notification.status === "SENT") return;

  try {
    const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    const reservation = reservationId
      ? await prisma.reservation.findUnique({ where: { id: reservationId }, include: { vehicle: true } })
      : null;

    if (!user?.email) {
      if (!deferProjection) await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED", error: "No recipient email on file." },
      });
      if (throwOnFailure) throw new Error("No recipient email on file");
      return;
    }

    const summary = reservation
      ? {
          confirmationNumber: reservation.confirmationNumber,
          vehicleName: `${reservation.vehicle.year} ${reservation.vehicle.make} ${reservation.vehicle.model}`,
          pickupAt: reservation.pickupAt,
          returnAt: reservation.returnAt,
          totalCents: reservation.totalCents,
          depositCents: reservation.depositCents,
        }
      : null;

    let html = "";
    switch (type) {
      case "COMMUNITY_UPDATE":
        html = "<p>You have a private update. Sign in to your Rent A 4Wheel account to view it.</p>";
        break;
      case "BOOKING_CONFIRMATION":
        html = summary ? bookingConfirmationEmail(summary) : "";
        break;
      case "PAYMENT_RECEIPT":
        html = paymentReceiptEmail({
          confirmationNumber: reservation?.confirmationNumber ?? "",
          amountCents: (extra?.amountCents as number) ?? reservation?.totalCents ?? 0,
          description: (extra?.description as string) ?? "Rental payment",
        });
        break;
      case "DEPOSIT_AUTH_FAILED":
        html = depositAuthFailedEmail({ confirmationNumber: reservation?.confirmationNumber ?? "" });
        break;
      case "TRIP_EMERGENCY_OVERRIDE":
        html = tripEmergencyOverrideEmail({
          confirmationNumber: reservation?.confirmationNumber ?? "",
          action: (extra?.action as string) ?? "override",
        });
        break;
      case "UPCOMING_RENTAL_REMINDER":
        html = summary ? upcomingRentalReminderEmail(summary) : "";
        break;
      case "PICKUP_REMINDER":
        html = summary ? pickupReminderEmail(summary) : "";
        break;
      case "RETURN_REMINDER":
        html = summary ? returnReminderEmail(summary) : "";
        break;
      case "CANCELLATION":
        html = cancellationEmail({ confirmationNumber: reservation?.confirmationNumber ?? "" });
        break;
      case "REFUND":
        html = refundEmail({
          confirmationNumber: reservation?.confirmationNumber ?? "",
          amountCents: (extra?.amountCents as number) ?? 0,
        });
        break;
      case "LATE_RETURN":
        html = lateReturnEmail({
          confirmationNumber: reservation?.confirmationNumber ?? "",
          additionalChargeCents: (extra?.additionalChargeCents as number) ?? 0,
        });
        break;
      default:
        html = "";
    }

    let delivery = notification.payload as { to: string; subject: string; html: string } | null;
    if (!delivery) {
      const snapshot = { to: user.email, subject: SUBJECTS[type], html };
      await prisma.notification.updateMany({ where: { id: notification.id, payload: { equals: Prisma.DbNull } }, data: { payload: snapshot } });
      const saved = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
      delivery = saved.payload as typeof snapshot;
    }
    const result = await sendEmail({ ...delivery, idempotencyKey: deliveryKey });

    if (!deferProjection) await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: result.sent ? "SENT" : "FAILED",
        error: result.error,
        sentAt: result.sent ? new Date() : undefined,
      },
    });
    if (!result.sent && throwOnFailure) throw new Error(result.error ?? "Email delivery failed");
  } catch (err) {
    if (!deferProjection) await prisma.notification.update({
      where: { id: notification.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : "Unknown error" },
    });
    if (throwOnFailure) throw err;
  }
}
