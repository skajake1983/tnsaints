/**
 * The daily staff brief: one email a day, instead of one per event.
 *
 * Resend's free tier is the tightest limit this system has, so new inquiries,
 * applications, offers about to lapse and billing problems are not emailed as
 * they happen. They are counted here, once a day, and sent to the staff
 * mailbox in the alert lane — or not at all, when there is nothing to say.
 *
 * Counts and links only. No child is named: the brief lands in a shared
 * mailbox, and the admin behind the links is where the details belong.
 */

import { flag } from '../lib/flags.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the brief would say right now. Every count is one small indexed query. */
export async function briefSummary(env, now = Date.now()) {
  const since = new Date(now - DAY_MS).toISOString();
  const soon = new Date(now + 2 * DAY_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
  const one = (sql, ...params) => env.DB.prepare(sql).bind(...params);
  const results = await env.DB.batch([
    one(`SELECT COUNT(*) AS n FROM crm_inquiries WHERE received_at >= ?1`, since),
    one(`SELECT COUNT(*) AS n FROM crm_inquiries WHERE status = 'new'`),
    one(`SELECT COUNT(*) AS n FROM crm_tasks WHERE status = 'open' AND due_on IS NOT NULL AND due_on <= ?1`, today),
    one(`SELECT COUNT(*) AS n FROM enrollments WHERE status = 'applied'`),
    one(`SELECT COUNT(*) AS n FROM enrollments WHERE status = 'waitlist'`),
    one(`SELECT COUNT(*) AS n FROM enrollments WHERE status = 'offered' AND offer_expires_at > ?1 AND offer_expires_at <= ?2`, nowIso, soon),
    one(`SELECT COUNT(*) AS n FROM enrollments WHERE status = 'past_due'`),
    one(`SELECT COUNT(*) AS n FROM billing_subscriptions WHERE enrollment_id IS NULL AND status NOT IN ('CANCELLED', 'EXPIRED')`),
    one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'billing.paid_without_seat' AND at >= ?1`, since),
    one(`SELECT COUNT(*) AS n FROM data_requests WHERE kind = 'deletion' AND status IN ('received', 'verified', 'scheduled')`),
  ]);
  const n = (i) => Number(results[i].results?.[0]?.n || 0);
  return {
    newInquiries: n(0),
    unhandledInquiries: n(1),
    tasksDue: n(2),
    applied: n(3),
    waitlist: n(4),
    offersLapsingSoon: n(5),
    pastDue: n(6),
    unlinkedSubscriptions: n(7),
    paidWithoutSeat: n(8),
    deletionRequests: n(9),
  };
}

/** Lines worth reading, each with where to act. Empty = nothing to send. */
export function briefLines(summary) {
  const lines = [];
  const add = (count, text, path) => { if (count > 0) lines.push({ text: text(count), path }); };
  add(summary.paidWithoutSeat, (c) => `${c} ${c === 1 ? 'family' : 'families'} paid but had no seat to take — refund or place them`, '/billing');
  add(summary.deletionRequests, (c) => `${c} data deletion ${c === 1 ? 'request is' : 'requests are'} waiting`, '/privacy');
  add(summary.pastDue, (c) => `${c} academy ${c === 1 ? 'place is' : 'places are'} past due in PayPal`, '/families');
  add(summary.offersLapsingSoon, (c) => `${c} seat ${c === 1 ? 'offer lapses' : 'offers lapse'} in the next two days`, '/enrollments');
  add(summary.applied, (c) => `${c} new academy ${c === 1 ? 'application' : 'applications'} to review`, '/enrollments');
  add(summary.newInquiries, (c) => `${c} website ${c === 1 ? 'inquiry' : 'inquiries'} in the last day (${summary.unhandledInquiries} not yet handled)`, '/inbox');
  add(summary.tasksDue, (c) => `${c} follow-up ${c === 1 ? 'task is' : 'tasks are'} due or overdue`, '/crm/tasks?view=overdue');
  add(summary.unlinkedSubscriptions, (c) => `${c} PayPal ${c === 1 ? 'subscription' : 'subscriptions'} not yet matched to a child`, '/billing');
  add(summary.waitlist, (c) => `${c} on the academy waiting list`, '/enrollments');
  return lines;
}

/**
 * Send today's brief, unless switched off or empty.
 * @param {(env, {lines, adminUrl}) => Promise<{ok: boolean}>} send  the composer in email.js
 */
export async function runStaffBrief(env, send, { force = false } = {}) {
  if (!force && !flag(env, 'STAFF_BRIEF_ENABLED', false)) return { sent: false, reason: 'disabled' };
  const lines = briefLines(await briefSummary(env));
  if (!lines.length) return { sent: false, reason: 'empty' };
  const adminUrl = `https://${String(env.ADMIN_HOSTNAME || 'admin.tnsaints.com').trim()}`;
  const result = await send(env, { lines, adminUrl });
  return { sent: Boolean(result.ok), reason: result.ok ? 'sent' : result.budget ? 'budget' : 'error' };
}
