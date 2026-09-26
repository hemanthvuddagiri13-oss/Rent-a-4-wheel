import { trace, traceOperation } from './acceptance-trace';
/** Bounded requests expose offline/error UI; they never retry a provider operation. */
export const boundedFetch: typeof fetch = async (input, init) => {
  const operation = traceOperation(input, init?.method); trace('request', operation);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, init?.body instanceof Uint8Array ? 120000 : 20000);
  try { const response = await fetch(input, { ...init, signal: controller.signal }); trace('response', operation, response.headers.get('x-request-id') ?? undefined, response.status); return response; }
  catch (error) { trace('transport-error', operation); throw error; }
  finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); }
};
