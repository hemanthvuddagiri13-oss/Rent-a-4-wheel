/** Bounded requests expose offline/error UI; they never retry a provider operation. */
export const boundedFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, init?.body instanceof Uint8Array ? 120000 : 20000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); }
};
