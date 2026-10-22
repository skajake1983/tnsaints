/**
 * What the website shows about an event (the Events plan, 2026-10-21): its
 * card in "Upcoming events", the banner when it is featured, and the share
 * wording. One function builds it, so the admin preview (EV2) and the public
 * API (EV3) can never disagree about the words.
 *
 * Public by construction: names, dates, places, times, price, open/full —
 * never counts of who signed up, never anyone's details.
 */

import { dateLine, gradeList } from '../programs/evaluation.js';

export const KIND_LABEL = {
  evaluation: 'Evaluation', open_gym: 'Open gym', camp: 'Camp', scrimmage: 'Scrimmage', tournament: 'Tournament',
};
export const CTA = { spot: 'Sign up', interest: 'Register interest', team: 'Enter a team' };

/** "6:00 PM" from "18:00"; '' for anything else. */
export function clock(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "9:00–11:00 AM" from the sessions' earliest start and latest end; '' without times. */
export function timeLine(sessions) {
  const starts = sessions.map((s) => s.start_time).filter((t) => /^\d{2}:\d{2}$/.test(String(t || ''))).sort();
  const ends = sessions.map((s) => s.end_time).filter((t) => /^\d{2}:\d{2}$/.test(String(t || ''))).sort();
  if (!starts.length) return '';
  const from = clock(starts[0]);
  if (!ends.length) return from;
  const to = clock(ends[ends.length - 1]);
  // "9:00–11:00 AM", but "11:00 AM–1:00 PM".
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)}–${to}` : `${from}–${to}`;
}

/** "Mar 4" from an ISO instant, in Central time. */
function shortDay(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
}

/** "Franklin" from "Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069", else the place itself. */
function town(location) {
  const parts = String(location || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  return parts[0] || '';
}

/**
 * @param {object} ev  a programs row (with signup_mode, starts_on, ends_on, location, banner/share text, price)
 * @param {Array} sessions  its active groups: name, start_time, end_time, capacity, (full)
 */
export function eventPublicModel(ev, sessions) {
  const days = [ev.starts_on, ev.ends_on].filter(Boolean);
  const when = dateLine(days.length ? days : sessions.map((s) => s.starts_on));
  const times = timeLine(sessions);
  const mode = ev.signup_mode === 'enroll' || !ev.signup_mode ? 'spot' : ev.signup_mode;
  const kind = KIND_LABEL[ev.kind] || 'Event';
  const price = ev.billing !== 'free' && Number.isInteger(Number(ev.price_cents)) && ev.price_cents !== null
    ? `$${(Number(ev.price_cents) / 100).toFixed(Number(ev.price_cents) % 100 ? 2 : 0)}`
    : null;
  const priceLine = price
    ? `${price}${ev.payment_policy === 'at_check_in' ? ', paid at check-in' : ''}`
    : 'Free';
  const grades = gradeList(ev.grade_min, ev.grade_max).split(',').filter(Boolean);
  const gradeLine = grades.length ? (grades.length === 1 ? `${grades[0]} grade` : `${grades[0]}–${grades[grades.length - 1]} grade`) : '';
  const closes = shortDay(ev.registration_closes_at);
  const bannerBits = [[when, times].filter(Boolean).join(' · '), town(ev.location), closes ? `Sign up by ${closes}` : '']
    .filter(Boolean);
  const share = ev.share_text || [`Tennessee Saints: ${ev.name}`, [when, times].filter(Boolean).join(', '),
    ev.location ? `at ${ev.location}` : '', gradeLine ? `for ${gradeLine}` : '', price ? priceLine : 'Free']
    .filter(Boolean).join(' — ');
  return {
    id: ev.id,
    kind: ev.kind,
    kind_label: kind,
    name: ev.name,
    description: ev.description || '',
    date_line: when,
    time_line: times,
    location: ev.location || '',
    grade_line: gradeLine,
    price_line: priceLine,
    signup_mode: mode,
    cta: CTA[mode] || 'Sign up',
    closes_line: closes ? `Sign up by ${closes}` : '',
    banner: {
      title: ev.banner_title || ev.name,
      text: ev.banner_text || bannerBits.join(' · '),
    },
    share_text: `${share}. https://tnsaints.com/?event=${ev.id}`,
    sessions: sessions.map((s) => ({
      name: s.name,
      time: [clock(s.start_time), clock(s.end_time)].filter(Boolean).join('–'),
      full: Boolean(s.full),
    })),
  };
}
