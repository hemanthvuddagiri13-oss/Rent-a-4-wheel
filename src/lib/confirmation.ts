import { randomInt } from "crypto";

export function generateConfirmationNumber(): string {
  const digits = Array.from({ length: 6 }, () => randomInt(0, 10)).join("");
  return `RA4W-${digits}`;
}
