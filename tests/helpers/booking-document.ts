import type { Page } from "playwright";
import { expect } from "vitest";

/** Uses the visible confirmation action; never intercepts the upload endpoint. */
export async function uploadBookingDocument(page: Page, index: number, buffer: Buffer, expectedScan: "CLEAN" | "QUARANTINED" = "CLEAN") {
  const region = page.locator("[data-document-upload]").nth(index);
  await region.locator("input[type=file]").last().setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer });
  await region.getByRole("img", { name: /Local preview/ }).waitFor();
  const response = page.waitForResponse(r => r.url().endsWith("/api/documents/upload") && r.request().method() === "POST");
  await region.getByRole("button", { name: "Upload this image", exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({malwareScanStatus:expectedScan});
  await region.getByText(expectedScan === "QUARANTINED" ? "Saved in quarantine. A security scan is required before review or use." : "Upload saved. Identity review is still required.", { exact: true }).waitFor();
}
