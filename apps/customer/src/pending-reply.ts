/** Keep the original optimistic version on uncertain delivery, even if a
 * background refresh sees the committed reply. No automatic retries or PII
 * persistence; the user explicitly retries the same immutable request. */
export class PendingReply {
  private input: { id: string; body: string; version: number } | null = null;
  get pending() { return this.input !== null; }
  async send(input: { id: string; body: string; version: number }, submit: (frozen: { id: string; body: string; version: number }) => Promise<unknown>) {
    this.input ??= { ...input };
    await submit(this.input);
    this.input = null;
  }
}
