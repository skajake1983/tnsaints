/**
 * Cross-site request forgery check for state-changing requests.
 *
 * THE ATTACK. A staff member (or, later, a parent) is signed in. They visit any
 * other page, and that page quietly submits a POST to our host. The browser
 * attaches the victim's credentials -- the Cloudflare Access cookie on admin,
 * the session cookie on the portal -- and the request arrives looking exactly
 * like one they made. SameSite cookies narrow this but do not close it: every
 * *.tnsaints.com page counts as same-SITE, so a hole anywhere on the domain
 * would be a hole here.
 *
 * THE CHECK, in the order browsers let us trust it:
 *
 *   1. Sec-Fetch-Site. Browsers set it and page script cannot forge it. When it
 *      is present it is authoritative: exactly "same-origin" passes and every
 *      other value fails. "same-site" fails ON PURPOSE -- that is precisely the
 *      sibling-subdomain case above.
 *
 *      Trusting it over Origin also matters for a quieter reason. Our pages send
 *      Referrer-Policy: no-referrer, and under that policy a browser sends
 *      `Origin: null` on a plain HTML form POST. A strict Origin comparison would
 *      refuse our own forms; Sec-Fetch-Site says same-origin for them correctly.
 *
 *   2. Origin, only when Sec-Fetch-Site is absent (older browsers, and anything
 *      that is not a browser). It must be allow-listed.
 *
 * This is the same shape as Go 1.25's net/http CrossOriginProtection.
 *
 * The result says WHICH layer failed so a caller can enforce one layer while
 * running the other in report mode first.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The values a browser actually sends. Anything else is logged as "other", not echoed. */
const KNOWN_SITE_VALUES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

/**
 * @param {Request} request
 * @param {{ isAllowedOrigin: (origin: string) => boolean }} options
 * @returns {{ ok: true } | { ok: false, layer: 'fetch-metadata' | 'origin', reason: string }}
 */
export function crossSiteCheck(request, { isAllowedOrigin }) {
  if (SAFE_METHODS.has(request.method)) return { ok: true };

  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null) {
    if (site === 'same-origin') return { ok: true };
    const value = KNOWN_SITE_VALUES.has(site) ? site : 'other';
    return { ok: false, layer: 'fetch-metadata', reason: `sec-fetch-site:${value}` };
  }

  const origin = request.headers.get('Origin');
  if (!origin) return { ok: false, layer: 'origin', reason: 'no-origin' };
  if (origin === 'null') return { ok: false, layer: 'origin', reason: 'null-origin' };
  if (!isAllowedOrigin(origin)) return { ok: false, layer: 'origin', reason: 'foreign-origin' };
  return { ok: true };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for an http(s) origin on this machine, e.g. http://127.0.0.1:8787. Local development only. */
export function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
