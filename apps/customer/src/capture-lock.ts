/** One native protection transition for any number of mounted private views.
 * Native iOS protection reparents the window, so repeated prevent calls are unsafe.
 * Transitions are serialized; an uncertain native failure requires an app restart.
 */
export class CaptureLock {
  private owners = new Set<symbol>();
  private enabled = false;
  private fault: Error | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(private driver: { prevent: () => Promise<void>; allow: () => Promise<void> }) {}
  private enqueue(work: () => Promise<void>) {
    const result = this.tail.then(async () => {
      if (this.fault) throw this.fault;
      try { await work(); } catch (error) { this.fault = error instanceof Error ? error : new Error('Native capture protection failed'); throw this.fault; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  acquire() {
    const owner = Symbol(); this.owners.add(owner);
    const ready = this.enqueue(async () => {
      if (!this.enabled) { await this.driver.prevent(); this.enabled = true; }
    });
    return { ready, release: () => {
      if (!this.owners.delete(owner)) return this.tail;
      return this.enqueue(async () => {
        if (!this.owners.size && this.enabled) { await this.driver.allow(); this.enabled = false; }
      });
    } };
  }
}
