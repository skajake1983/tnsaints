/**
 * What every admin route module shares: the navigation, and the standard
 * answers -- not permitted (HTML or JSON) and post-redirect-get.
 */

import { json } from '../http.js';
import { page, esc, htmlResponse, adminHeaders } from './ui.js';

export const NAV = [
  { href: '/', label: 'Roster' },
  { href: '/eval', label: 'Evaluations' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/enrollments', label: 'Enrollments' },
  { href: '/families', label: 'Families' },
  { href: '/billing', label: 'Billing' },
  { href: '/crm', label: 'CRM' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/users', label: 'Users' },
  { href: '/clearances', label: 'Clearances' },
  { href: '/profile', label: 'Profile' },
];

/** A route's refusal for a page: 403 with the admin shell. `sub` is plain text. */
export function denyHtml(title, sub = '') {
  return (rc) =>
    htmlResponse(
      page({
        title,
        principal: rc.principal,
        nav: NAV,
        body: `<h1>Not permitted</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}`,
      }),
      { status: 403 }
    );
}

/** A route's refusal for a JSON endpoint. */
export function denyJson(error) {
  return () => json({ ok: false, error }, { status: 403 });
}

/** 303 to an admin path, behind the local development prefix when there is one. */
export function seeOther(base, path) {
  return new Response(null, { status: 303, headers: adminHeaders({ Location: `${base}${path}` }) });
}

/** A 404 page in the admin shell. */
export function notFoundPage(principal, heading, sub = '') {
  return htmlResponse(
    page({ title: 'Not found', principal, nav: NAV, body: `<h1>${esc(heading)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}` }),
    { status: 404 }
  );
}
