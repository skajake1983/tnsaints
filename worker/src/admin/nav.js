/**
 * What every admin route module shares: the navigation, and the standard
 * answers -- not permitted (HTML or JSON) and post-redirect-get.
 */

import { json } from '../http.js';
import { page, esc, htmlResponse, adminHeaders } from './ui.js';

// Each link carries the capability its page needs, so the menu shows a role
// only what it can open (ui.js page()). tests/test_routes.py checks every cap
// here against the route it links to.
//
// Grouped in the order a family moves through the academy (owner,
// 2026-10-20): leads and families, evaluations, programs, money, then running
// the organization. `group` is the menu heading, in order of first
// appearance; "Today" (the daily brief) sits above the groups as the place to
// start, and `account` links sit with the signed-in name.
export const NAV = [
  { href: '/brief', label: 'Today', cap: 'events:manage' },
  { href: '/crm', label: 'Leads (CRM)', cap: 'crm:view', group: 'Families' },
  { href: '/families', label: 'Families', cap: 'roster:view', group: 'Families' },
  { href: '/', label: 'Roster', cap: 'roster:view', group: 'Evaluations' },
  { href: '/eval', label: 'Evaluations', cap: 'notes:write', group: 'Evaluations' },
  { href: '/decisions', label: 'Decisions', cap: 'decisions:set', group: 'Evaluations' },
  { href: '/programs', label: 'Programs', cap: 'events:manage', group: 'Programs' },
  { href: '/enrollments', label: 'Enrollments', cap: 'enrollments:manage', group: 'Programs' },
  { href: '/teams', label: 'Teams', cap: 'teams:view', group: 'Programs' },
  { href: '/billing', label: 'Billing', cap: 'billing:manage', group: 'Money' },
  // Admins and the board treasurer; another board member is told why not.
  { href: '/donations', label: 'Donations', cap: 'board:view', group: 'Money' },
  { href: '/board', label: 'Board', cap: 'board:view', group: 'Organization' },
  { href: '/users', label: 'Users', cap: 'staff:manage', group: 'Organization' },
  { href: '/clearances', label: 'Clearances', cap: 'clearances:manage', group: 'Organization' },
  { href: '/privacy', label: 'Privacy', cap: 'privacy:manage', group: 'Organization' },
  { href: '/profile', label: 'Profile', cap: 'staff', account: true },
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
