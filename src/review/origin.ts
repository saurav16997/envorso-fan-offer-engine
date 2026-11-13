/** Local CSRF boundary only. This is not authentication or a production host policy. */
export function validLocalOrigin(origin: string | null, host: string | null): boolean {
  if (!host) return false;
  try {
    const local = new URL(`http://${host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) return false;
    if (origin === null) return true;
    const from = new URL(origin);
    return from.protocol === 'http:' && from.host === local.host;
  } catch { return false; }
}
