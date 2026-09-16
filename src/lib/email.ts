import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM = process.env.EMAIL_FROM || "Rent A 4Wheel <bookings@renta4wheel.com>";

export interface SendEmailParams {
  idempotencyKey?: string;
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends a transactional email via Resend. When RESEND_API_KEY is not
 * configured (local development without credentials), this logs the
 * email to the console instead of throwing, so the rest of the app
 * (bookings, notifications) keeps working end-to-end in a dev environment.
 */
export async function sendEmail({ to, subject, html, idempotencyKey }: SendEmailParams): Promise<{ sent: boolean; error?: string }> {
  if (!resend) {
    console.log(`[email:dev-mode] Would send "${subject}" to ${to}`);
    return { sent: false, error: "RESEND_API_KEY not configured (development mode)." };
  }

  try {
    const result = await resend.emails.send({ from: FROM, to, subject, html }, idempotencyKey ? { idempotencyKey } : undefined);
    if (result.error) return { sent: false, error: result.error.message };
    return { sent: true };
  } catch (err) {
    console.error("Failed to send email", err);
    return { sent: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
