/**
 * Which event a staff member is looking at (the Events plan, 2026-10-21).
 *
 * Roster, Evaluations and Decisions — pages, their scripts and their JSON
 * calls — all read env.EVENT_ID. Rather than thread an event through every
 * link and fetch, the event a person picks is remembered in a cookie on the
 * admin host, and index.js gives every admin request that event's settings
 * (programs/evaluation.js withEvent). With no choice, it is the current
 * evaluation, as before.
 *
 * The cookie only selects among events staff may already see; it carries no
 * authority. HttpOnly, Secure, SameSite=Strict, and it expires after a
 * working day so nobody is left on an old event by surprise.
 */

import { EVENT_ID_RE } from '../programs/evaluation.js';

export const EVENT_COOKIE = 'tns_admin_event';
const MAX_AGE = 12 * 60 * 60;

/** The event id the request's cookie names, or null. */
export function chosenEvent(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === EVENT_COOKIE) {
      const value = rest.join('=').trim();
      return EVENT_ID_RE.test(value) ? value : null;
    }
  }
  return null;
}

/** Set-Cookie for a choice, or for clearing it (null). */
export function eventCookie(id) {
  return id
    ? `${EVENT_COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Strict`
    : `${EVENT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
