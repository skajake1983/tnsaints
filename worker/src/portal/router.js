/**
 * The parent portal, served on its own hostname (portal.tnsaints.com).
 *
 * Why its own host rather than a path on tnsaints.com or api.tnsaints.com:
 *   - the session cookie is `__Host-` prefixed, which pins it to exactly this
 *     host: the browser will never send it to api.* or admin.*, and nothing on
 *     another subdomain can set or overwrite it;
 *   - tnsaints.com stays on GitHub Pages, untouched and free;
 *   - its CSP and headers are its own, independent of the marketing site's.
 *
 * Everything here defaults CLOSED:
 *   - PORTAL_ENABLED must be exactly "true", or every path answers with the
 *     maintenance page (503);
 *   - without AUTH_PEPPER there is no safe way to store a secret, so the same;
 *   - every state-changing request passes the cross-site check, BOTH layers
 *     enforced from day one — unlike the admin there are no older clients
 *     to ease in, and a parent's session can change a child's medical record.
 *
 * Pages are server-rendered plain HTML forms with post-redirect-get, so every
 * flow works without JavaScript except following a sign-in link (see
 * auth-pages.js for why that page needs it).
 */

import { flag, choice } from '../lib/flags.js';
import { crossSiteCheck, originAllowed } from '../lib/csrf.js';
import { authConfigured } from '../lib/crypto.js';
import { readForm, BodyTooLarge } from '../lib/body.js';
import { logoResponse } from '../admin/logo.js';
import { loadSession, revokeSession, clearedCookie, SESSION_COOKIE } from '../auth/session.js';
import { requestLink, verifyLink, renderSignIn } from '../auth/magic.js';
import { googleConfigured, startGoogle, finishGoogle } from '../auth/google.js';
import { verifyPage, redirect } from './auth-pages.js';
import { familyRoutes, isFamilyPath } from './family.js';
import { inviteLanding, acceptInvitation } from './guardians.js';
import { esc, requestContext, portalPage, portalResponse, notFoundResponse, maintenanceResponse } from './ui.js';

/**
 * @param {Request} request
 * @param {object} env
 * @param {ExecutionContext} ctx
 * @param {{ path: string, base: string }} route  from resolveSurface(): the path
 *        with any local development prefix removed, and that prefix, so pages
 *        can build links that work in both places.
 */
export async function handlePortal(request, env, ctx, route) {
  const pathname = route.path;
  const isDev = route.base !== '';
  const rc = requestContext({
    base: route.base,
    siteUrl: env.SITE_URL,
    // The TEST MODE banner appears once PayPal is configured for its sandbox,
    // not before: there is nothing to pay for until then.
    testMode: choice(env, 'PAYPAL_ENV', ['sandbox', 'live'], null) === 'sandbox',
  });
  const method = request.method === 'HEAD' ? 'GET' : request.method;

  // Before the switch, like the admin: the same public bytes tnsaints.com
  // serves, needed by the maintenance page itself.
  if (pathname === '/logo.png' && method === 'GET') {
    return logoResponse();
  }

  if (!flag(env, 'PORTAL_ENABLED', false)) {
    return maintenanceResponse(rc);
  }
  if (!authConfigured(env)) {
    console.error(JSON.stringify({ event: 'portal_auth_misconfigured' }));
    return maintenanceResponse(rc);
  }

  if (method !== 'GET') {
    const check = crossSiteCheck(request, {
      isAllowedOrigin: (origin) =>
        originAllowed(origin, { expectedHost: env.PORTAL_HOSTNAME, requestUrl: request.url, isDev }),
    });
    if (!check.ok) {
      console.warn(JSON.stringify({ event: 'portal_csrf_blocked', reason: check.reason, method: request.method }));
      return refusedResponse(rc);
    }
  }

  const session = await loadSession(env, request, ctx);

  if (pathname === '/auth/email' && method === 'POST') {
    if (!flag(env, 'MAGIC_LINK_ENABLED', false)) {
      return renderSignIn(env, rc, {
        status: 503,
        errors: [{ id: 'email', message: 'Email sign-in is paused right now. Please try again later.' }],
      });
    }
    return withForm(request, rc, (form) => requestLink(env, ctx, request, rc, form));
  }

  if (pathname === '/auth/email/verify' && method === 'GET') {
    return verifyPage(rc);
  }

  if (pathname === '/auth/email/verify' && method === 'POST') {
    return withForm(request, rc, (form) => verifyLink(env, ctx, request, rc, form));
  }

  if (pathname === '/auth/google/start' && method === 'POST') {
    if (!googleConfigured(env)) return notFoundResponse(rc);
    return withForm(request, rc, (form) => {
      const mode = form.get('mode') === 'link' ? 'link' : 'signin';
      // Connecting Google changes how this account can be signed into, so it
      // needs a fresh proof of identity, not a three-week-old cookie.
      if (mode === 'link' && !(session && session.recentAuth)) {
        return problemResponse(rc, 403, 'For your security, please sign out and sign in again, then connect Google.');
      }
      return startGoogle(env, request, rc, { isDev, mode });
    });
  }

  if (pathname === '/auth/google/callback' && method === 'GET') {
    if (!googleConfigured(env)) return notFoundResponse(rc);
    return finishGoogle(env, ctx, request, rc, { isDev, session });
  }

  if (pathname === '/auth/signout' && method === 'POST') {
    if (session) await revokeSession(env, session.idHash);
    return redirect(rc.url('/'), [clearedCookie(SESSION_COOKIE)]);
  }

  // An invitation can be opened signed out; accepting it explains how to sign in.
  if (pathname === '/invite' && method === 'GET') {
    return inviteLanding(rc);
  }
  if (pathname === '/invite/accept' && method === 'POST') {
    return withForm(request, rc, (form) => acceptInvitation(env, ctx, rc, session, form));
  }

  // Everything about a family needs a signed-in parent. Signed out, the front
  // door is the sign-in page and every other family path leads back to it.
  if (isFamilyPath(pathname)) {
    if (!session) {
      return pathname === '/' && method === 'GET' ? renderSignIn(env, rc) : redirect(rc.url('/'));
    }
    const response = await familyRoutes({
      env, ctx, request, rc, session, pathname, method,
      readForm: (handler) => withForm(request, rc, handler),
    });
    if (response) return response;
  }

  return notFoundResponse(rc);
}

/** Parse a form body (capped) and hand it on, or answer the problem plainly. */
async function withForm(request, rc, handler) {
  let form;
  try {
    form = await readForm(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) return problemResponse(rc, 413, 'That form was too large to send.');
    throw err;
  }
  if (!form) return problemResponse(rc, 415, "We couldn't read that form. Please go back and try again.");
  return handler(form);
}

function problemResponse(rc, status, message) {
  return portalResponse(
    portalPage({
      rc,
      title: 'Something went wrong',
      body: `<h1>Something went wrong</h1><p class="lede">${esc(message)}</p>
<p><a class="btn" href="${esc(rc.url('/'))}">Back to the parent portal</a></p>`,
    }),
    { status }
  );
}

/** A state change that did not come from a portal page. Nothing was done. */
function refusedResponse(rc) {
  return problemResponse(
    rc,
    403,
    "That request didn't come from the parent portal, so nothing was changed. Please go back and try again."
  );
}
