/**
 * Refuses a request that a browser says was started by another site (CSRF): `Sec-Fetch-Site` cross-site or same-site.
 * Accepted: same-origin, none (typed address, bookmark), and an absent header (curl, the CLI, tests: they are not a browser page).
 * Returns the error text for a 403 (what was refused and what to do), undefined when the request may go on.
 * A body-less POST is a "simple" request a foreign page can send without a preflight, which is why a JSON body cannot be the protection.
 */
export function crossSiteRefusal(req: unknown): string | undefined {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers;
  const raw = headers?.['sec-fetch-site'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'cross-site' || value === 'same-site') {
    return `Refused: this request was started by another site (Sec-Fetch-Site: ${value}). Log files can only be changed from the Queue dashboard itself: open the dashboard and use the buttons of its Log files page, or call the route with curl.`;
  }
  return undefined;
}
