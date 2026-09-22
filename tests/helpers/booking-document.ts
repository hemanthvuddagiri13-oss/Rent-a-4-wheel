import type { Page } from "playwright";
import { expect } from "vitest";

/** Uses the visible confirmation action; never intercepts the upload endpoint. */
export async function uploadBookingDocument(page: Page, index: number, buffer: Buffer) {
  const region = page.locator("[data-document-upload]").nth(index);
  await region.locator("input[type=file]").last().setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer });
  await region.getByRole("img", { name: /Local preview/ }).waitFor();
  const response = page.waitForResponse(r => r.url().endsWith("/api/documents/upload") && r.request().method() === "POST");
  await region.getByRole("button", { name: "Upload this image", exact: true }).click();
  expect((await response).status()).toBe(200);
  await region.getByText("Upload saved. Identity review is still required.", { exact: true }).waitFor();
}
