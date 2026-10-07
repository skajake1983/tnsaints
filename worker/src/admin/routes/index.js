/**
 * The admin route table: every page and endpoint on admin.tnsaints.com, each
 * with the capability it requires.
 *
 * FAILS CLOSED, CHECKED AT LOAD. A route must name a capability some role
 * actually carries, or 'staff' for "any signed-in staff member". A route that
 * forgets, or misspells one, throws as this module loads -- the Worker does not
 * start and every test fails -- rather than serving a page to everyone, or to
 * no one, in silence.
 *
 * Each entry: { method, path, cap, deny?, handler }.
 *   path     an exact string or a RegExp; a RegExp's match goes to the handler
 *   deny     (rc, match) => Response for a principal without `cap`; defaults
 *            to a plain 403 page
 *   handler  (rc, match) => Response, called only once `cap` is satisfied
 * rc = { request, env, ctx, principal, url, base, pathname }
 */

import { knownCapabilities } from '../../auth/staff.js';
import { denyHtml } from '../nav.js';
import { routes as roster } from './roster.js';
import { routes as evaluation } from './eval.js';
import { routes as decisions } from './decisions.js';
import { routes as users } from './users.js';
import { routes as enrollments } from './enrollments.js';
import { routes as families } from './families.js';
import { routes as billing } from './billing.js';
import { routes as crm } from './crm.js';
import { routes as privacy } from './privacy.js';
import { routes as brief } from './brief.js';
import { routes as clearances } from './clearances.js';

const METHODS = new Set(['GET', 'POST']);

export function validateRoutes(table, capabilities = knownCapabilities()) {
  const seen = new Set();
  for (const r of table) {
    const label = `${r.method} ${r.path}`;
    if (!METHODS.has(r.method)) throw new Error(`admin route ${label}: method must be GET or POST`);
    if (!(typeof r.path === 'string' || r.path instanceof RegExp)) throw new Error(`admin route ${label}: bad path`);
    if (r.cap !== 'staff' && !capabilities.has(r.cap)) {
      throw new Error(`admin route ${label}: unknown or missing capability "${r.cap}"`);
    }
    if (typeof r.handler !== 'function') throw new Error(`admin route ${label}: no handler`);
    if (r.deny !== undefined && typeof r.deny !== 'function') throw new Error(`admin route ${label}: deny must be a function`);
    if (seen.has(label)) throw new Error(`admin route ${label}: declared twice`);
    seen.add(label);
  }
  return table;
}

export const ROUTES = validateRoutes([
  ...roster, ...evaluation, ...decisions, ...users, ...enrollments,
  ...families, ...billing, ...crm, ...privacy, ...brief, ...clearances,
]);

/** The first route for this method and path, with its RegExp match (or [path]). */
export function matchRoute(method, pathname, table = ROUTES) {
  for (const route of table) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, match: [pathname] };
    } else {
      const match = route.path.exec(pathname);
      if (match) return { route, match };
    }
  }
  return null;
}

export const defaultDeny = denyHtml('Not permitted');
