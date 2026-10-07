/**
 * The admin surface, served on its own hostname.
 *
 * WHY A HOSTNAME AND NOT api.tnsaints.com/admin
 * ----------------------------------------------
 * Same Worker, same D1, same-origin fetch — the split is not about
 * infrastructure. It is about which way a mistake fails.
 *
 * api.tnsaints.com must keep /api/register and /api/availability public
 * forever, so any Access application on that hostname is necessarily
 * path-scoped. Path-scoped policies fail OPEN: add /api/staff/... in six
 * months, forget to widen the include rule, and it is on the public internet
 * serving children's medical notes with no error anywhere. admin.tnsaints.com/*
 * fails CLOSED — a path nobody thought about is still behind the door.
 *
 * The decisive argument is blast radius. A fat-fingered Access policy on
 * api.tnsaints.com during a live campaign breaks parent registration. On a
 * separate hostname the same mistake breaks only the dashboard, and families
 * signing up never notice.
 *
 * It also keeps machine-to-machine endpoints (the PayPal webhook) on
 * api.tnsaints.com, outside Access entirely: a payment provider cannot do SSO,
 * so on a path-scoped app you would be carving an exception into the policy you
 * just wrote.
 *
 * THIS FILE does the parts every request shares — who is asking (Access, then
 * the staff list), and whether the request came from an admin page — and then
 * hands over to the route table (routes/index.js), where every route names the
 * capability it needs. tests/test_routes.py pins what each route answers for
 * each role.
 */

import { json } from '../http.js';
import { verifyAccessJwt, devPrincipalEmail } from '../auth/access.js';
import { loadStaff, can, audit } from '../auth/staff.js';
import { page, esc, htmlResponse, notAuthorisedPage } from './ui.js';
import { logoResponse } from './logo.js';
import { crossSiteCheck, originAllowed } from '../lib/csrf.js';
import { choice } from '../lib/flags.js';
import { NAV } from './nav.js';
import { matchRoute, defaultDeny } from './routes/index.js';

/**
 * May a state-changing admin request carry this Origin? The shared rule in
 * lib/csrf.js (originAllowed), against ADMIN_HOSTNAME. Exported so it is
 * tested directly (tests/test_admin_csrf.py) rather than only through report
 * mode, which lets everything through and so proves nothing. `isDev` is true
 * only when the dev bypass signed the request in (DEV_ADMIN_EMAIL set, no
 * Cf-Ray header).
 */
export function adminOriginAllowed(origin, { env, requestUrl, isDev }) {
  return originAllowed(origin, { expectedHost: env.ADMIN_HOSTNAME, requestUrl, isDev });
}

/**
 * Refuse state changes that did not come from an admin page. See lib/csrf.js.
 *
 * Cloudflare Access proves WHO is asking; it says nothing about which page made
 * the browser ask. Without this, any website a signed-in coach visits could
 * POST to /api/eval/... or /api/batch/.../drain with their Access cookie.
 *
 * Two layers, rolled out separately:
 *   - Sec-Fetch-Site is ENFORCED now. Every current browser sends it, and our
 *     own pages always send "same-origin", so nothing legitimate is refused.
 *     Clients that omit it (the Python suites) are unaffected.
 *   - The Origin fallback, for requests with no Sec-Fetch-Site, starts in
 *     REPORT mode (ADMIN_CSRF_MODE="report"): it logs what it would have
 *     refused. Once the logs show only expected traffic it moves to "enforce",
 *     which also means the test helpers must start sending the admin Origin.
 *
 * An unset or misspelled mode enforces — a protection must not switch itself
 * off because a config line went missing.
 *
 * @returns {Response | null} a refusal, or null to carry on
 */
function adminCrossSite(request, env, ctx, principal, isDev, pathname) {
  const check = crossSiteCheck(request, {
    isAllowedOrigin: (origin) => adminOriginAllowed(origin, { env, requestUrl: request.url, isDev }),
  });
  if (check.ok) return null;

  const mode = choice(env, 'ADMIN_CSRF_MODE', ['report', 'enforce'], 'enforce');
  if (check.layer === 'origin' && mode === 'report') {
    console.warn(
      JSON.stringify({ event: 'admin_csrf_would_block', reason: check.reason, method: request.method })
    );
    return null;
  }

  console.warn(JSON.stringify({ event: 'admin_csrf_blocked', reason: check.reason, method: request.method }));
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'admin.csrf_blocked',
      detail: { reason: check.reason, method: request.method, path: pathname },
    })
  );

  const message = 'This request did not come from the admin site, so it was not carried out. Reload the page and try again.';
  if (pathname.startsWith('/api/')) {
    return json({ ok: false, error: message }, { status: 403 });
  }
  return htmlResponse(
    page({ title: 'Request refused', body: `<h1>Request refused</h1><p class="sub">${esc(message)}</p>` }),
    { status: 403 }
  );
}

/**
 * Everything on this hostname is gated. There is no public path here by
 * design — see the module comment on failing closed.
 */
export async function handleAdmin(request, env, ctx, path, base = '') {
  const url = new URL(request.url);
  // Resolved by the dispatcher, which strips the local development prefix. Do
  // not read url.pathname directly here — that would make every route below
  // wrong under local dev, which is exactly where they get tested.
  const pathname = path || url.pathname;

  // Served before the STAFF check — Cloudflare Access still gates the hostname
  // in front of it, so this is not a public URL. It sits here so the response
  // stays a plain cacheable image rather than something that varies by
  // principal: these are the same bytes tnsaints.com serves to anyone, and
  // nothing about who is signed in can be inferred from them.
  if (pathname === '/logo.png' && request.method === 'GET') {
    return logoResponse();
  }

  // Local development only — see devPrincipalEmail(). Null in production.
  const devEmail = devPrincipalEmail(request, env);
  const verified = devEmail
    ? { ok: true, email: devEmail, sub: 'dev', claims: {} }
    : await verifyAccessJwt(request, env);

  if (!verified.ok) {
    // 401 rather than 403: the visitor has not proven who they are. In normal
    // operation this is unreachable, because Access redirects to login before
    // the request ever arrives — reaching it means either a direct hit that
    // bypassed the Access app, or a misconfiguration. Both are worth seeing.
    const detail =
      verified.reason === 'misconfigured'
        ? 'This admin app is not fully configured yet. Contact Jacob.'
        : 'Sign in through the Tennessee Saints staff login to continue.';

    return htmlResponse(
      page({
        title: 'Sign in required',
        body: `<h1>Sign in required</h1><p class="sub">${esc(detail)}</p>`,
      }),
      { status: 401 }
    );
  }

  const principal = await loadStaff(env, verified.email);

  if (!principal) {
    // Authenticated, not authorised. This is the control that survives someone
    // widening the Access policy: being admitted through the door is not the
    // same as being on the staff list.
    console.warn(
      JSON.stringify({ event: 'admin_denied_not_staff', email_domain: verified.email.split('@')[1] })
    );
    ctx.waitUntil(
      audit(env, {
        actor: verified.email,
        action: 'admin.denied',
        detail: { reason: 'not-in-staff' },
      })
    );
    return htmlResponse(notAuthorisedPage(verified.email), { status: 403 });
  }

  const forged = adminCrossSite(request, env, ctx, principal, Boolean(devEmail), pathname);
  if (forged) return forged;

  const found = matchRoute(request.method, pathname);
  if (!found) {
    return htmlResponse(
      page({
        title: 'Not found',
        principal,
        nav: NAV,
        body: `<h1>Not found</h1><p class="sub">No admin page at ${esc(pathname)}.</p>`,
      }),
      { status: 404 }
    );
  }

  const rc = { request, env, ctx, principal, url, base, pathname };
  const { route, match } = found;
  if (route.cap !== 'staff' && !can(principal, route.cap)) {
    return (route.deny || defaultDeny)(rc, match);
  }
  return route.handler(rc, match);
}
