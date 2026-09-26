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
 * Everything here defaults CLOSED. PORTAL_ENABLED must be exactly "true" or
 * every path answers with the maintenance page (503), so a missing or
 * misspelled setting can never expose a half-built surface.
 *
 * Pages are server-rendered with no script. Routes that change state arrive
 * with sign-in (P1.5) and each passes the cross-site check in lib/csrf.js.
 */

import { flag, choice } from '../lib/flags.js';
import { logoResponse } from '../admin/logo.js';
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

  if (pathname === '/' && method === 'GET') {
    return homePage(rc);
  }

  return notFoundResponse(rc);
}

/**
 * The front door. Sign-in (magic link and Google) replaces the placeholder
 * paragraph in P1.5/P1.6; until then the portal is reachable only locally, and
 * in production only once PORTAL_ENABLED is switched on at launch.
 */
function homePage(rc) {
  return portalResponse(
    portalPage({
      rc,
      title: 'Parent portal',
      body: `<h1>Tennessee Saints parent portal</h1>
<p class="lede">Create your family account, add your children, and apply to the academy — all in one place.</p>
<div class="panel">
  <h2 style="margin-top:0">Sign in</h2>
  <p>Sign-in is being set up. Until it opens, email
  <a href="mailto:info@tnsaints.com">info@tnsaints.com</a> and we'll help directly.</p>
</div>
<p><a href="${esc(rc.siteUrl)}">Back to tnsaints.com</a></p>`,
    })
  );
}
