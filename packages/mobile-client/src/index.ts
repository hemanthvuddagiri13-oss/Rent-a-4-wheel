import { operationMetadata, type MobileOperations } from "./generated";
export type { MobileOperations } from "./generated";
export class MobileApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly requestId: string) { super(code); }
}
/** No storage and no automatic retries. The Expo application owns Keychain /
 * Keystore integration and serializes refresh. Never log request options. */
export function createMobileClient(options: { baseUrl: string; accessToken: () => Promise<string | null>; fetch?: typeof fetch; allowLocalHttp?: boolean }) {
  const origin = new URL(options.baseUrl);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.protocol !== "https:" && !(options.allowLocalHttp && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw new Error("An HTTPS API origin is required");
  return {
    async call<K extends keyof MobileOperations>(operation: K, input: MobileOperations[K]["input"], signal?: AbortSignal): Promise<MobileOperations[K]["output"]> {
      const op = operationMetadata[operation];
      const args = input as { params?: Record<string, string>; body?: unknown; query?: { limit?: number; cursor?: string }; idempotencyKey?: string; fileAccess?: string; contentType?: string };
      let path: string = op.path;
      for (const [key, value] of Object.entries(args.params ?? {})) path = path.replace("{" + key + "}", encodeURIComponent(value));
      if (/[{}]/.test(path)) throw new Error("Missing path parameter");
      const url = new URL("/api/v1/mobile" + path, origin);
      for (const [key, value] of Object.entries(args.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      const headers: Record<string, string> = { "X-API-Version": "1", Accept: "application/json" };
      if (op.auth) { const token = await options.accessToken(); if (!token) throw new MobileApiError(401, "UNAUTHORIZED", ""); headers.Authorization = "Bearer " + token; }
      if (args.idempotencyKey) headers["Idempotency-Key"] = args.idempotencyKey;
      if (args.fileAccess) headers["X-File-Access"] = args.fileAccess;
      if (args.body !== undefined) headers["Content-Type"] = args.contentType ?? "application/json";
      const response = await (options.fetch ?? fetch)(url, { method: op.method, headers, credentials: "omit", redirect: "error", cache: "no-store", signal, ...(args.body !== undefined ? { body: op.binary === "request" ? new Uint8Array(args.body as Uint8Array) : JSON.stringify(args.body) } : {}) });
      if (response.headers.get("x-api-version") !== "1") throw new MobileApiError(response.status, "API_VERSION_MISMATCH", response.headers.get("x-request-id") ?? "");
      if (response.ok && op.binary === "response") return await response.arrayBuffer() as MobileOperations[K]["output"];
      const envelope = await response.json() as { data: MobileOperations[K]["output"]; error: { code: string } | null; requestId: string };
      if (!response.ok || envelope.error) throw new MobileApiError(response.status, envelope.error?.code ?? "UNAVAILABLE", envelope.requestId);
      return envelope.data;
    },
  };
}
