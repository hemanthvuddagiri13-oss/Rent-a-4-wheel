import { createMobileClient, MobileApiError, type MobileOperations } from './index';
export type Credentials = MobileOperations['signIn']['output'];
export interface Vault { get(): Promise<string | null>; set(value: string): Promise<void>; clear(): Promise<void> }
type Stored = { credentials: Credentials; refreshing?: boolean };
export class SignInRequired extends Error { constructor() { super('Your secure session needs a new email code.'); } }

/** One coordinator per app process. Persist uncertainty BEFORE rotating a one-use token. */
export class Session {
  private credentials: Credentials | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  onChange: (signedIn: boolean) => void = () => {};
  constructor(private vault: Vault, private origin: string, private transport?: typeof fetch, private localTest = false) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next;
  }
  private client(token: string | null) { return createMobileClient({ baseUrl: this.origin, accessToken: async () => token, fetch: this.transport, allowLocalHttp: this.localTest }); }
  async restore() {
    return this.serial(async () => {
      if (this.loaded) return Boolean(this.credentials);
      this.loaded = true;
      try {
        const raw = await this.vault.get(); if (!raw) return false;
        const saved = JSON.parse(raw) as Stored;
        if (saved.refreshing || !saved.credentials?.refreshToken || !saved.credentials.accessToken || !Number.isFinite(Date.parse(saved.credentials.refreshExpiresAt)) || Date.parse(saved.credentials.refreshExpiresAt) <= Date.now()) { await this.clear(); return false; }
        this.credentials = saved.credentials; this.onChange(true); return true;
      } catch { await this.clear(); return false; }
    });
  }
  private async clear() { this.credentials = null; this.onChange(false); await this.vault.clear(); }
  async signIn(input: MobileOperations['signIn']['input']) {
    return this.serial(async () => {
      const credentials = await this.client(null).call('signIn', input);
      await this.vault.set(JSON.stringify({ credentials }));
      this.loaded = true; this.credentials = credentials; this.onChange(true);
    });
  }
  async token(rejectedToken?: string): Promise<string> {
    return this.serial(async () => {
      const c = this.credentials; if (!c) throw new SignInRequired();
      // A concurrent request may already have rotated the rejected generation.
      if (Date.parse(c.accessExpiresAt) > Date.now() + 30000 && (!rejectedToken || rejectedToken !== c.accessToken)) return c.accessToken;
      try {
        await this.vault.set(JSON.stringify({ credentials: c, refreshing: true }));
        const credentials = await this.client(null).call('refresh', { body: { refreshToken: c.refreshToken } });
        await this.vault.set(JSON.stringify({ credentials })); this.credentials = credentials;
        return credentials.accessToken;
      } catch { await this.clear(); throw new SignInRequired(); }
    });
  }
  async call<K extends keyof MobileOperations>(op: K, input: MobileOperations[K]['input'], signal?: AbortSignal): Promise<MobileOperations[K]['output']> {
    const token = await this.token();
    try { return await this.client(token).call(op, input, signal); }
    catch (e) {
      if (!(e instanceof MobileApiError) || e.status !== 401) throw e;
      const next = await this.token(token);
      try { return await this.client(next).call(op, input, signal); }
      catch (again) { if (again instanceof MobileApiError && again.status === 401) await this.serial(() => this.clear()); throw again; }
    }
  }
  async logout(all = false) {
    // Refresh first if necessary; serialize logout behind every rotation.
    await this.token();
    return this.serial(async () => {
      if (!this.credentials) return;
      await this.client(this.credentials.accessToken).call(all ? 'logoutAll' : 'logout', { body: {} });
      await this.clear();
    });
  }
}
