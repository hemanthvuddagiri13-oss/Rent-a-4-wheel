/** Browser receives a public location only, never native credentials or claims.
 * Resource ownership is checked independently by the authenticated web route. */
export function privateBrowserUrl(origin: string, path: string, allowLocalHttp = false) {
  const base = new URL(origin);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !(base.protocol === 'https:' || allowLocalHttp && base.origin === 'http://localhost:3000')) throw new Error('Unapproved browser origin');
  if (!/^\/account\/reservations\/[A-Za-z0-9_-]{1,128}(?:#signed-agreement)?$/.test(path)) throw new Error('Unsupported browser destination');
  return new URL(path, base.origin).toString();
}
