const CODES = new Set(["P2002", "P2003", "P2025", "P2034", "23505", "23P01", "ETIMEDOUT", "ECONNRESET"]);
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && CODES.has(code) ? code : "OPERATION_FAILED";
}
export function safeLog(event: string, error?: unknown, operationId?: string) {
  // Call sites supply static event labels. Never serialize exception objects,
  // messages, request bodies, provider results, or Prisma invocation arguments.
  console.error({ event: /^[A-Z_]+$/.test(event) ? event : "OPERATION_FAILED", code: safeErrorCode(error),
    ...(operationId && /^[a-zA-Z0-9_-]{1,80}$/.test(operationId) ? { operationId } : {}) });
}
