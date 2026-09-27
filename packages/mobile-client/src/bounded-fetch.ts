type Timing = { trace: (phase: string, operation?: string, requestId?: string, status?: number) => void; traceOperation: (input: Parameters<typeof fetch>[0], method?: string) => string | undefined; timingRequestId: () => string };
export function createBoundedFetch(deliver: typeof fetch, { trace, traceOperation, timingRequestId }: Timing): typeof fetch {
/** Bounded requests expose offline/error UI; they never retry a provider operation. */
return async (input, init) => {
  const operation = traceOperation(input, init?.method); const timingId = operation === 'requestCode' ? timingRequestId() : undefined; trace('request', operation, timingId);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener('abort', abort);
  const timer = setTimeout(() => { trace('deadline', operation, timingId); abort(); }, init?.body instanceof Uint8Array ? 120000 : 20000);
  try { const response = await deliver(input, { ...init, ...(timingId ? { headers: (() => { const headers = new Headers(init?.headers); headers.set('x-native-timing-id', timingId); return headers; })() } : {}), signal: controller.signal }); trace('response', operation, response.headers.get('x-request-id') ?? undefined, response.status); return response; }
  catch (error) { trace('transport-error', operation, timingId); throw error; }
  finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); }
};

}
