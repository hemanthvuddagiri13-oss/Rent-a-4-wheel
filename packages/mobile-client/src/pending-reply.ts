import { MobileApiError } from './index';
/** Keep the original optimistic version on uncertain delivery, even if a
 * background refresh sees the committed reply. No automatic retries or PII
 * persistence; the user explicitly retries the same immutable request. */
export class PendingReply {
  private input: { id: string; body: string; version: number } | null = null;
  get pending() { return this.input !== null; }
  async send(input: { id: string; body: string; version: number }, submit: (frozen: { id: string; body: string; version: number }) => Promise<unknown>) {
    this.input ??= { ...input };
    try { await submit(this.input); this.input = null; }
    catch (error) {
      // These are authoritative route rejections before this command commits.
      // Transport/5xx uncertainty retains the exact intention for replay.
      if (error instanceof MobileApiError && [400, 401, 403, 404, 409, 415, 422].includes(error.status)) this.input = null;
      throw error;
    }
  }
}
