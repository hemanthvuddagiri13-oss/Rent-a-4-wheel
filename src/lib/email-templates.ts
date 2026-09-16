import { formatCurrency } from "@/lib/utils";
import { SITE_URL } from "@/lib/constants";

function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#050505;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:32px 0;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:12px;overflow:hidden;border:1px solid #262626;">
            <tr>
              <td style="padding:28px 32px;border-bottom:1px solid #262626;">
                <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:1px;">RENT A <span style="color:#D4AF37;">4</span>WHEEL</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="font-size:22px;margin:0 0 16px;color:#F5C542;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #262626;color:#8A8A8A;font-size:12px;">
                Rent A 4Wheel &middot; Dallas, TX &middot; <a href="${SITE_URL}" style="color:#D4AF37;">renta4wheel.com</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function row(label: string, value: string) {
  return `<tr>
    <td style="padding:6px 0;color:#8A8A8A;font-size:13px;">${label}</td>
    <td style="padding:6px 0;color:#ffffff;font-size:13px;text-align:right;">${value}</td>
  </tr>`;
}

interface ReservationSummary {
  confirmationNumber: string;
  vehicleName: string;
  pickupAt: Date;
  returnAt: Date;
  totalCents: number;
  depositCents: number;
}

function fmtDate(d: Date) {
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function signInCodeEmail(params: { code: string; expiresInMinutes: number }) {
  return layout(
    "Your Sign-In Code",
    `<p style="color:#D9D9D9;font-size:14px;line-height:1.6;">Enter this code to sign in to Rent A 4Wheel. It expires in ${params.expiresInMinutes} minutes and can only be used once.</p>
     <p style="margin:24px 0;text-align:center;">
       <span style="display:inline-block;padding:14px 28px;background:#1a1a1a;border:1px solid #D4AF37;border-radius:8px;font-size:28px;font-weight:700;letter-spacing:8px;color:#F5C542;">${params.code}</span>
     </p>
     <p style="color:#8A8A8A;font-size:12px;line-height:1.6;">If you didn't request this code, you can safely ignore this email — no one can access your account without it.</p>`
  );
}

export function depositAuthFailedEmail(params: { confirmationNumber: string }) {
  return layout(
    "We Couldn't Authorize Your Security Deposit",
    `<p style="color:#D9D9D9;font-size:14px;line-height:1.6;">Your rental payment for reservation <strong>${params.confirmationNumber}</strong> succeeded, but we were unable to authorize the required security deposit hold on your card. Your reservation is not yet confirmed.</p>
     <p style="color:#D9D9D9;font-size:14px;line-height:1.6;">Please sign in and try again with a different card, or contact support for help.</p>`
  );
}

export function tripEmergencyOverrideEmail(params: { confirmationNumber: string; action: string }) {
  return layout(
    "A Staff Action Was Taken On Your Trip",
    `<p style="color:#D9D9D9;font-size:14px;line-height:1.6;">Rent A 4Wheel staff performed an emergency override (${params.action}) on reservation <strong>${params.confirmationNumber}</strong>. This is logged and reviewed — contact support if you have questions.</p>`
  );
}

export function bookingConfirmationEmail(r: ReservationSummary) {
  return layout(
    "Your Reservation is Confirmed",
    `<p style="color:#D9D9D9;font-size:14px;line-height:1.6;">Thanks for booking with Rent A 4Wheel! Here are your reservation details:</p>
     <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
       ${row("Confirmation #", r.confirmationNumber)}
       ${row("Vehicle", r.vehicleName)}
       ${row("Pickup", fmtDate(r.pickupAt))}
       ${row("Return", fmtDate(r.returnAt))}
       ${row("Total Paid", formatCurrency(r.totalCents))}
       ${r.depositCents ? row("Security Deposit", formatCurrency(r.depositCents)) : ""}
     </table>
     <p style="color:#8A8A8A;font-size:13px;margin-top:20px;">Manage your reservation any time from your account dashboard.</p>`
  );
}

export function paymentReceiptEmail(r: { confirmationNumber: string; amountCents: number; description: string }) {
  return layout(
    "Payment Receipt",
    `<table width="100%" cellpadding="0" cellspacing="0">
       ${row("Confirmation #", r.confirmationNumber)}
       ${row("Description", r.description)}
       ${row("Amount Charged", formatCurrency(r.amountCents))}
     </table>`
  );
}

export function upcomingRentalReminderEmail(r: ReservationSummary) {
  return layout(
    "Your Rental is Coming Up",
    `<p style="color:#D9D9D9;font-size:14px;">This is a reminder that your rental begins soon.</p>
     <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
       ${row("Confirmation #", r.confirmationNumber)}
       ${row("Vehicle", r.vehicleName)}
       ${row("Pickup", fmtDate(r.pickupAt))}
     </table>`
  );
}

export function driverVerificationRequestEmail(name: string) {
  return layout(
    "Action Needed: Verify Your Driver Information",
    `<p style="color:#D9D9D9;font-size:14px;">Hi ${name}, we need a bit more information to verify your driver's license before your rental can be finalized. Please sign in to your account and upload the requested documents.</p>`
  );
}

export function pickupReminderEmail(r: ReservationSummary) {
  return layout(
    "Pickup Reminder",
    `<p style="color:#D9D9D9;font-size:14px;">Your pickup is scheduled for ${fmtDate(r.pickupAt)}. Please bring your driver's license and the card used for payment.</p>`
  );
}

export function returnReminderEmail(r: ReservationSummary) {
  return layout(
    "Return Reminder",
    `<p style="color:#D9D9D9;font-size:14px;">Your rental is due back on ${fmtDate(r.returnAt)}. Late returns may incur additional charges.</p>`
  );
}

export function cancellationEmail(r: { confirmationNumber: string }) {
  return layout(
    "Reservation Cancelled",
    `<p style="color:#D9D9D9;font-size:14px;">Your reservation ${r.confirmationNumber} has been cancelled. If you believe this is a mistake, please contact support.</p>`
  );
}

export function refundEmail(r: { confirmationNumber: string; amountCents: number }) {
  return layout(
    "Refund Processed",
    `<table width="100%" cellpadding="0" cellspacing="0">
       ${row("Confirmation #", r.confirmationNumber)}
       ${row("Refund Amount", formatCurrency(r.amountCents))}
     </table>`
  );
}

export function lateReturnEmail(r: { confirmationNumber: string; additionalChargeCents: number }) {
  return layout(
    "Late Return Notice",
    `<p style="color:#D9D9D9;font-size:14px;">Your vehicle for reservation ${r.confirmationNumber} was returned late. An additional charge of ${formatCurrency(
      r.additionalChargeCents
    )} has been applied per the Rental Agreement.</p>`
  );
}
