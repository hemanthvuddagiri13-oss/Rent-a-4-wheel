import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import {
  bookingConfirmationEmail,
  cancellationEmail,
  lateReturnEmail,
  paymentReceiptEmail,
  pickupReminderEmail,
  refundEmail,
  returnReminderEmail,
  upcomingRentalReminderEmail,
} from "@/lib/email-templates";
import type { NotificationType } from "@prisma/client";

interface QueueNotificationParams {
  userId?: string;
  reservationId?: string;
  type: NotificationType;
  extra?: Record<string, unknown>;
}

const SUBJECTS: Record<NotificationType, string> = {
  BOOKING_CONFIRMATION: "Your Rent A 4Wheel reservation is confirmed",
  PAYMENT_RECEIPT: "Your Rent A 4Wheel payment receipt",
  UPCOMING_RENTAL_REMINDER: "Your Rent A 4Wheel rental is coming up",
  DRIVER_VERIFICATION_REQUEST: "Action needed: verify your driver information",
  PICKUP_REMINDER: "Pickup reminder — Rent A 4Wheel",
  RETURN_REMINDER: "Return reminder — Rent A 4Wheel",
  CANCELLATION: "Your reservation has been cancelled",
  REFUND: "Your refund has been processed",
  LATE_RETURN: "Late return notice",
};

export async function queueNotification({ userId, reservationId, type, extra }: QueueNotificationParams) {
  const notification = await prisma.notification.create({
    data: { userId, reservationId, type, channel: "EMAIL", status: "PENDING", subject: SUBJECTS[type] },
  });

  try {
    const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    const reservation = reservationId
      ? await prisma.reservation.findUnique({ where: { id: reservationId }, include: { vehicle: true } })
      : null;

    if (!user?.email) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "FAILED", error: "No recipient email on file." },
      });
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

    const result = await sendEmail({ to: user.email, subject: SUBJECTS[type], html });

    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: result.sent ? "SENT" : "FAILED",
        error: result.error,
        sentAt: result.sent ? new Date() : undefined,
      },
    });
  } catch (err) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : "Unknown error" },
    });
  }
}
