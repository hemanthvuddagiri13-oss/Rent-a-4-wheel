import { createMobileClient, MobileApiError, type MobileOperations } from './index';
export type Credentials = MobileOperations['signIn']['output'];
export interface Vault { get(): Promise<string | null>; set(value: string): Promise<void>; clear(): Promise<void> }
type Stored = { credentials: Credentials; refreshing?: boolean };
export class SignInRequired extends Error { constructor() { super('Your secure session needs a new sign-in. Use your phone or linked email.'); } }

/** One coordinator per app process. Persist uncertainty BEFORE rotating a one-use token. */
export class Session {
  private credentials: Credentials | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private identityEpoch = 0;
  onChange: (signedIn: boolean) => void = () => {};
  beforeRestore: () => Promise<void> = async () => {};
  onEnd: () => Promise<void> = async () => {};
  constructor(private vault: Vault, private origin: string, private transport?: typeof fetch, private localTest = false) {}
  captureIdentity() {
    const epoch = this.identityEpoch;
    return () => { if (epoch !== this.identityEpoch || !this.credentials) throw new SignInRequired(); };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next;
  }
  private client(token: string | null) { return createMobileClient({ baseUrl: this.origin, accessToken: async () => token, fetch: this.transport, allowLocalHttp: this.localTest }); }
  async restore() {
    return this.serial(async () => {
      if (this.loaded) return Boolean(this.credentials);
      await this.beforeRestore();
      // A locked/unavailable Keychain is not evidence of invalid credentials.
      // Fail closed without deleting them; reopening after unlock may restore.
      const raw = await this.vault.get();
      this.loaded = true;
      try {
        if (!raw) return false;
        const saved = JSON.parse(raw) as Stored;
        if (saved.refreshing || !saved.credentials?.refreshToken || !saved.credentials.accessToken || !Number.isFinite(Date.parse(saved.credentials.refreshExpiresAt)) || Date.parse(saved.credentials.refreshExpiresAt) <= Date.now()) { await this.clear(); return false; }
        this.credentials = saved.credentials; this.onChange(true); return true;
      } catch { await this.clear(); return false; }
    });
  }
  private async clear() {
    this.identityEpoch++; this.credentials = null; this.onChange(false);
    // A crash or failed native deletion must not restore credentials during
    // pending cleanup. Retain this credential-free marker until cleanup succeeds.
    await this.vault.set(JSON.stringify({ ending: true }));
    await this.onEnd(); await this.vault.clear();
  }
  async signIn(input: MobileOperations['signIn']['input']) {
    return this.serial(async () => {
      await this.beforeRestore();
      const credentials = await this.client(null).call('signIn', input);
      await this.vault.set(JSON.stringify({ credentials }));
      this.identityEpoch++; this.loaded = true; this.credentials = credentials; this.onChange(true);
    });
  }
  async signInPhone(input: MobileOperations['phoneSignIn']['input']) {
    return this.serial(async () => {
      await this.beforeRestore();
      const credentials = await this.client(null).call('phoneSignIn', input);
      await this.vault.set(JSON.stringify({ credentials }));
      this.identityEpoch++; this.loaded = true; this.credentials = credentials; this.onChange(true);
    });
  }
  async forgetRevokedSession() { return this.serial(() => this.clear()); }
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
      } catch {
        // Preserve the public fail-closed auth result even when native cleanup
        // itself is unavailable. clear() already invalidated the in-memory epoch;
        // durable cleanup evidence is retried before the next restoration.
        try { await this.clear(); } finally { throw new SignInRequired(); }
      }
    });
  }
  async call<K extends keyof MobileOperations>(op: K, input: MobileOperations[K]['input'], signal?: AbortSignal): Promise<MobileOperations[K]['output']> {
    const epoch = this.identityEpoch;
    const endingSelf = op === 'revokeDevice' && (input as MobileOperations['revokeDevice']['input']).body.sessionId === this.credentials?.sessionId;
    const finish = async () => { if (endingSelf) await this.serial(async () => { if (epoch === this.identityEpoch) await this.clear(); }); };
    const token = await this.token();
    if (epoch !== this.identityEpoch) throw new SignInRequired();
    try {
      const result = await this.client(token).call(op, input, signal);
      if (epoch !== this.identityEpoch) throw new SignInRequired();
      await finish(); return result;
    }
    catch (e) {
      if (!(e instanceof MobileApiError) || e.status !== 401) throw e;
      // An old request must never be retried under a newly signed-in account.
      if (epoch !== this.identityEpoch) throw new SignInRequired();
      const next = await this.token(token);
      if (epoch !== this.identityEpoch) throw new SignInRequired();
      try {
        const result = await this.client(next).call(op, input, signal);
        if (epoch !== this.identityEpoch) throw new SignInRequired();
        await finish(); return result;
      }
      catch (again) { if (again instanceof MobileApiError && again.status === 401) await this.serial(async () => { if (epoch === this.identityEpoch) await this.clear(); }); throw again; }
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
