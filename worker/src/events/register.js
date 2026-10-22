/**
 * The website's events (the Events plan, phase EV3) — on api.tnsaints.com:
 *
 *   GET  /api/events                 open, listed events: cards, the banner, open/full per session
 *   GET  /api/events/:id             one open event (listed or not) with its form and waiver
 *   POST /api/events/:id/register    sign up: a place (spot), interest, or a team entry
 *
 * EVENTS_ENABLED must be exactly "true"; until then the list is empty, one
 * event is 404 and sign-up answers 503, so the website shows nothing. Every
 * public rule /api/register keeps is kept: allow-listed origins, a size cap,
 * the honeypot and too-fast check, Turnstile, limits per connection, per email
 * and per day, the sign-up window, a waiver the form actually showed.
 *
 * EMAIL: nothing is sent unless EVENT_EMAILS_ENABLED is exactly "true" (the
 * owner, 2026-10-21: no email goes out without their approval). A sign-up is
 * recorded, reaches the CRM and the daily brief, either way.
 *
 * Public by construction: open/full, never counts; no one's details.
 */

import { json, errorResponse, hashIp, clientIp } from '../http.js';
import { botSignals, validateRegistration, allowedGrades } from '../validate.js';
import { verifyTurnstile } from '../turnstile.js';
import { flag } from '../lib/flags.js';
import { rateLimit } from '../lib/ratelimit.js';
import { readJson, BodyTooLarge } from '../lib/body.js';
import { withEvent, EVENT_ID_RE } from '../programs/evaluation.js';
import { claimSpot, registrationWindow, newCancelToken } from '../registration.js';
import { eventPublicModel } from './public.js';
import { eventFields, validateInterest, validateTeam } from './fields.js';
import { featuredEvent } from './manage.js';
import { recordEventSignup } from '../crm/events.js';
import { sendRegistrationEmails, sendEventSignupEmails } from '../email.js';
import { markInvitationUsed } from './invitations.js';
import { onlinePaymentReady, startEventCheckout, payLinkCheckout, promoteTeam, tellPromotedTeam, HOLD_MINUTES } from './payments.js';

const iso = () => new Date().toISOString();

/** Today in Central, YYYY-MM-DD: an event is upcoming through its last day. */
function centralToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/**
 * Open events with their sessions and how full each is. `id` set: that one,
 * listed or not; else every listed one. Drafts, closed and archived events and
 * past ones are never returned.
 */
export async function openEvents(env, id = null) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, COALESCE(p.event_kind, p.kind) AS shown_kind FROM programs p
      WHERE p.status = 'open' AND p.signup_mode IN ('spot', 'interest', 'team')
        AND ((?1 IS NOT NULL AND p.id = ?1) OR (?1 IS NULL AND p.public = 1))
        AND COALESCE(p.ends_on, p.starts_on, '9999-12-31') >= ?2
      ORDER BY p.starts_on IS NULL, p.starts_on, p.name LIMIT 30`
  ).bind(id, centralToday()).all();
  const rows = results || [];
  if (!rows.length) return [];
  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.program_id, g.name, g.start_time, g.end_time, g.starts_on, g.capacity,
            CASE p.signup_mode
              WHEN 'spot' THEN (SELECT COUNT(*) FROM registrations r
                                 WHERE r.event_id = g.program_id AND r.session_time = g.name AND r.status = 'confirmed')
              WHEN 'team' THEN (SELECT COUNT(*) FROM event_teams t WHERE t.group_id = g.id AND t.status = 'entered')
              ELSE 0 END AS taken
       FROM program_groups g JOIN programs p ON p.id = g.program_id
      WHERE g.status = 'active' AND g.program_id IN (SELECT value FROM json_each(?1))
      ORDER BY g.starts_on IS NULL, g.starts_on, g.start_time IS NULL, g.start_time, g.name`
  ).bind(JSON.stringify(rows.map((r) => r.id))).all();
  return rows.map((r) => {
    const sessions = (groups || []).filter((g) => g.program_id === r.id).map((g) => ({
      ...g, full: r.signup_mode !== 'interest' && Number(g.taken) >= Number(g.capacity),
    }));
    return { row: { ...r, kind: r.shown_kind }, sessions };
  });
}

/** Sign-ups open right now? The same rule the portal and /api/register use. */
function signupOpen(row, now = Date.now()) {
  if (row.status !== 'open') return false;
  if (row.registration_opens_at && Date.parse(row.registration_opens_at) > now) return false;
  if (row.registration_closes_at && Date.parse(row.registration_closes_at) <= now) return false;
  return true;
}

function publicEvent({ row, sessions }, featured) {
  const model = eventPublicModel(row, sessions);
  const open = signupOpen(row);
  return {
    ...model,
    featured: featured === row.id,
    registration_open: open,
    opens_at: row.registration_opens_at || null,
    closes_at: row.registration_closes_at || null,
    // Every session full and no waiting list: nothing left to sign up for.
    all_full: row.signup_mode !== 'interest' && sessions.length > 0 && sessions.every((s) => s.full) && !Number(row.waitlist_enabled),
    waitlist: row.signup_mode !== 'interest' && Boolean(Number(row.waitlist_enabled)),
    // The link-preview card's image (a page on tnsaints.com: programs/manage.js), if staff set one.
    image: /^https:\/\/(www\.)?tnsaints\.com\//.test(String(row.preview_image || '')) ? row.preview_image : null,
  };
}

async function waiverFor(env, row) {
  if (!row.waiver_version_id || row.signup_mode === 'interest') return null;
  return env.DB.prepare(`SELECT id, legal_entity, title, body_text, body_sha256 FROM waiver_versions WHERE id = ?1`)
    .bind(row.waiver_version_id).first();
}

const cacheable = (cors) => ({ cors, headers: { 'Cache-Control': 'public, max-age=30' } });

export async function handleEventsList(env, cors) {
  if (!flag(env, 'EVENTS_ENABLED', false)) return json({ ok: true, enabled: false, featured: null, events: [] }, cacheable(cors));
  const [events, featured] = await Promise.all([openEvents(env), featuredEvent(env)]);
  const out = events.map((e) => publicEvent(e, featured));
  return json({ ok: true, enabled: true, featured: out.some((e) => e.featured) ? featured : null, events: out }, cacheable(cors));
}

export async function handleEventDetail(env, cors, id) {
  if (!flag(env, 'EVENTS_ENABLED', false) || !EVENT_ID_RE.test(id)) return errorResponse('No such event.', 404, cors);
  const [found] = await openEvents(env, id);
  if (!found) return errorResponse('That event is not open for sign-ups.', 404, cors);
  const [featured, waiver, evEnv] = await Promise.all([featuredEvent(env), waiverFor(env, found.row), withEvent(env, id)]);
  const event = publicEvent(found, featured);
  return json({
    ok: true,
    event: {
      ...event,
      fields: eventFields(found.row, found.sessions.map((s) => s.name), allowedGrades(evEnv)),
      waiver: waiver ? { id: waiver.id, title: waiver.title, legal_entity: waiver.legal_entity, text: waiver.body_text } : null,
    },
  }, cacheable(cors));
}

const MESSAGES = {
  closed: 'Sign-ups for this event have closed. Email info@tnsaints.com and we will let you know about the next one.',
  'not-yet': "Sign-ups for this event haven't opened yet.",
};

export async function handleEventRegister(request, env, ctx, cors, id) {
  if (!cors['Access-Control-Allow-Origin']) return errorResponse('Requests from this origin are not allowed.', 403, cors);
  if (!flag(env, 'EVENTS_ENABLED', false)) return errorResponse('Please try again in a moment.', 503, cors);
  if (!EVENT_ID_RE.test(id)) return errorResponse('No such event.', 404, cors);
  const [found] = await openEvents(env, id);
  if (!found) return errorResponse('That event is not open for sign-ups.', 404, cors);
  const { row, sessions } = found;
  const evEnv = await withEvent(env, id);
  const window = registrationWindow(evEnv);
  if (!signupOpen(row) || !window.open) {
    return errorResponse(MESSAGES[window.reason] || MESSAGES.closed, 403, cors, { registration_open: false });
  }

  let body;
  try {
    body = await readJson(request, 16 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLarge) return errorResponse('That submission was too large.', 413, cors);
    throw err;
  }
  if (!body) return errorResponse('We could not read that submission. Please try again.', 400, cors);
  if (botSignals(body).length) return errorResponse('We could not verify that submission. Please try again.', 400, cors);

  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);
  const connection = await rateLimit(env, [
    { scope: 'event-ip-10m', subject: ipHash, limit: 5, windowSeconds: 10 * 60 },
    { scope: 'event-day', subject: 'all', limit: 400, windowSeconds: 24 * 60 * 60 },
  ]);
  if (!connection.allowed) {
    return errorResponse('Too many sign-ups from this connection. If you are signing up several players, please email info@tnsaints.com.', 429, cors);
  }
  const human = await verifyTurnstile(body.turnstile_token, ip, env);
  if (!human.ok) {
    return errorResponse('We could not verify that you are human. Please refresh the page and try again.',
      human.reason === 'misconfigured' ? 500 : 403, cors);
  }

  const mode = row.signup_mode;
  const names = sessions.map((s) => s.name);
  const grades = allowedGrades(evEnv);
  const checked = mode === 'interest' ? validateInterest(body, grades)
    : mode === 'team' ? validateTeam(body, names)
      : validateRegistration(names.length === 1 && !body.session_time ? { ...body, session_time: names[0] } : body, evEnv,
        { kind: row.kind });
  if (!checked.ok) return errorResponse('Please correct the highlighted fields.', 400, cors, { errors: checked.errors });
  const value = checked.value;
  const email = value.parent_email_norm || value.coach_email_norm;
  const perEmail = await rateLimit(env, [{ scope: 'event-email-day', subject: email, limit: 5, windowSeconds: 24 * 60 * 60 }]);
  if (!perEmail.allowed) return errorResponse('We have had several sign-ups for this email today. Please email info@tnsaints.com.', 429, cors);

  // What is owed: nothing, at check-in, or online now (held while they pay).
  const price = row.billing !== 'free' && Number(row.price_cents) > 0 ? Number(row.price_cents) : 0;
  const online = price > 0 && row.payment_policy === 'online';
  if (online && !(await onlinePaymentReady(env))) {
    return errorResponse("Online payment isn't available right now. Please try again later, or email info@tnsaints.com.", 503, cors);
  }
  const payment = {
    payment_state: online ? 'pending' : price ? 'at_check_in' : null,
    hold_expires_at: online ? new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString() : null,
    amount_due_cents: price || null,
  };
  const site = (env.SITE_URL || 'https://tnsaints.com').replace(/\/$/, '');

  // The waiver the form showed must be the event's current one.
  const waiver = await waiverFor(env, row);
  if (mode !== 'interest' && (!waiver || String(body.waiver_version_id || '') !== waiver.id)) {
    return errorResponse('This event\'s waiver has changed. Please reload the page and sign again.', 409, cors, { code: 'waiver-changed' });
  }

  let result;
  if (mode === 'spot') {
    const group = sessions.find((s) => s.name === value.session_time);
    result = await claimSpot(evEnv, { ...value, ...payment, group_id: group ? group.id : null, waiver_version_id: waiver.id,
      waiver_sha256: waiver.body_sha256, source: 'website' }, ipHash);
    if (result.status === 'duplicate') {
      return errorResponse('That player is already signed up for this event. Email info@tnsaints.com to change it.', 409, cors);
    }
    if (result.status === 'waitlist' && !Number(row.waitlist_enabled)) {
      // No waiting list for this event: the place was not there to take.
      await env.DB.prepare(`DELETE FROM registrations WHERE cancel_token = ?1 AND status = 'waitlist'`).bind(result.cancelToken).run();
      return errorResponse('That session is full. Please choose another, or email info@tnsaints.com.', 409, cors, { code: 'full' });
    }
    const reg = await env.DB.prepare(`SELECT id FROM registrations WHERE cancel_token = ?1`).bind(result.cancelToken).first();
    result.registrationId = reg ? Number(reg.id) : null;
    if (online && result.status === 'confirmed') {
      const pay = await startEventCheckout(env, { kind: 'registration', id: result.registrationId, event: { id, name: row.name }, site })
        .catch(() => ({ ok: false }));
      if (!pay.ok) {
        // Payment could not start: the place goes straight back.
        await env.DB.prepare(`UPDATE registrations SET status = 'cancelled', payment_state = 'expired', cancelled_at = ?2,
                                cancel_reason = 'Payment could not start' WHERE id = ?1`).bind(result.registrationId, iso()).run();
        return errorResponse("Online payment isn't available right now. Please try again later, or email info@tnsaints.com.", 503, cors);
      }
      result.checkoutUrl = pay.url;
    }
  } else if (mode === 'interest') {
    const token = newCancelToken();
    const now = iso();
    try {
      const row2 = await env.DB.prepare(
        `INSERT INTO event_interest (event_id, player_name, player_name_norm, grade, parent_name, parent_email, parent_email_norm,
                                     phone, notes, status, cancel_token, ip_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'interested', ?10, ?11, ?12, ?12) RETURNING id`
      ).bind(id, value.player_name, value.player_name_norm, value.grade, value.parent_name, value.parent_email,
        value.parent_email_norm, value.phone, value.notes, token, ipHash, now).first();
      result = { status: 'interested', cancelToken: token, interestId: Number(row2.id) };
    } catch (err) {
      if (/UNIQUE/i.test(String(err?.message))) {
        return errorResponse("We already have that player's interest. We'll be in touch.", 409, cors);
      }
      throw err;
    }
  } else {
    const group = sessions.find((s) => s.name === value.division);
    const token = newCancelToken();
    const now = iso();
    try {
      // The division's size is checked in the same statement, so two coaches
      // entering the last place at once cannot both get it.
      const row2 = await env.DB.prepare(
        `INSERT INTO event_teams (event_id, group_id, team_name, team_name_norm, coach_name, coach_email, coach_email_norm,
                                  coach_phone, players_count, notes, status, waiver_version_id, waiver_sha256, agreement,
                                  signature, signed_at, cancel_token, ip_hash, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                CASE WHEN (SELECT COUNT(*) FROM event_teams WHERE group_id = ?2 AND status = 'entered') < ?11
                     THEN 'entered' ELSE 'waitlist' END,
                ?12, ?13, 1, ?14, ?15, ?16, ?17, ?15, ?15
         RETURNING id, status`
      ).bind(id, group.id, value.team_name, value.team_name_norm, value.coach_name, value.coach_email, value.coach_email_norm,
        value.coach_phone, value.players_count, value.notes, Number(group.capacity), waiver.id, waiver.body_sha256,
        value.signature, now, token, ipHash).first();
      // An entry fee: owed at check-in, or held while the coach pays (a waiting team owes nothing yet).
      if (payment.payment_state && row2.status === 'entered') {
        await env.DB.prepare(`UPDATE event_teams SET payment_state = ?2, hold_expires_at = ?3, amount_due_cents = ?4 WHERE id = ?1`)
          .bind(row2.id, payment.payment_state, payment.hold_expires_at, payment.amount_due_cents).run();
      }
      if (row2.status === 'waitlist' && !Number(row.waitlist_enabled)) {
        await env.DB.prepare(`DELETE FROM event_teams WHERE id = ?1`).bind(row2.id).run();
        return errorResponse('That division is full. Please choose another, or email info@tnsaints.com.', 409, cors, { code: 'full' });
      }
      result = { status: row2.status === 'entered' ? 'confirmed' : 'waitlist', cancelToken: token, teamId: Number(row2.id) };
      if (online && row2.status === 'entered') {
        const pay = await startEventCheckout(env, { kind: 'team', id: result.teamId, event: { id, name: row.name }, site })
          .catch(() => ({ ok: false }));
        if (!pay.ok) {
          await env.DB.prepare(`UPDATE event_teams SET status = 'withdrawn', payment_state = 'expired', updated_at = ?2 WHERE id = ?1`)
            .bind(result.teamId, iso()).run();
          return errorResponse("Online payment isn't available right now. Please try again later, or email info@tnsaints.com.", 503, cors);
        }
        result.checkoutUrl = pay.url;
      }
    } catch (err) {
      if (/UNIQUE/i.test(String(err?.message))) {
        return errorResponse('A team with that name is already entered. Email info@tnsaints.com if that is a mistake.', 409, cors);
      }
      throw err;
    }
  }

  // Came from an invitation's link: mark it, and say so on the sign-up.
  const invitationId = await markInvitationUsed(env, id, body.invitation);
  if (invitationId && result.registrationId) {
    await env.DB.prepare(`UPDATE registrations SET invitation_id = ?2, source = 'invite' WHERE id = ?1`)
      .bind(result.registrationId, invitationId).run();
  } else if (invitationId && result.interestId) {
    await env.DB.prepare(`UPDATE event_interest SET invitation_id = ?2 WHERE id = ?1`).bind(result.interestId, invitationId).run();
  }

  // After the reply: the CRM, and (only if the owner has switched them on) emails.
  ctx.waitUntil(afterSignup(env, evEnv, row, mode, value, result));

  if (result.checkoutUrl) {
    return json({ ok: true, status: 'pending_payment', checkout_url: result.checkoutUrl,
      message: `Your place is held for ${HOLD_MINUTES} minutes while you pay.` }, { cors });
  }
  const emails = flag(env, 'EVENT_EMAILS_ENABLED', false);
  const then = (emails ? ' Watch for a confirmation email.' : '')
    + (payment.payment_state === 'at_check_in' ? ` Please bring $${(price / 100).toFixed(price % 100 ? 2 : 0)} to check-in.` : '');
  const message = result.status === 'interested'
    ? `Thanks — we have your interest in ${row.name}. We'll be in touch to confirm.`
    : result.status === 'waitlist'
      ? `That ${mode === 'team' ? 'division' : 'session'} is full, so you're on the waiting list${result.position ? ` (number ${result.position})` : ''}. We'll be in touch if a place opens.`
      : mode === 'team'
        ? `${value.team_name} is entered in ${row.name}.${then}`
        : `${value.player_name} is signed up for ${row.name}.${then}`;
  return json({ ok: true, status: result.status, position: result.position || null, message }, { cors });
}

async function afterSignup(env, evEnv, row, mode, value, result) {
  try {
    await recordEventSignup(env, { event: row, mode, value, result });
  } catch (err) {
    console.error(JSON.stringify({ event: 'event_crm_failed', message: String(err?.message || '').slice(0, 120) }));
  }
  if (!flag(env, 'EVENT_EMAILS_ENABLED', false)) return;
  try {
    if (mode === 'spot') {
      await sendRegistrationEmails(evEnv, value, result, { alert: Boolean(Number(row.notify_each_signup)) });
    } else {
      await sendEventSignupEmails(evEnv, { event: row, mode, value, result });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'event_email_failed', message: String(err?.message || '').slice(0, 120) }));
  }
}

/**
 * A withdraw link for interest or a team entry (cancel.html uses one link for
 * everything). Read-only lookup; the change is the POST.
 */
export async function lookupEventToken(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [interest, team] = await env.DB.batch([
    env.DB.prepare(`SELECT i.id, i.event_id, i.player_name AS name, i.status, p.name AS event_label FROM event_interest i
                      JOIN programs p ON p.id = i.event_id WHERE i.cancel_token = ?1`).bind(token),
    env.DB.prepare(`SELECT t.id, t.event_id, t.team_name AS name, t.status, p.name AS event_label FROM event_teams t
                      JOIN programs p ON p.id = t.event_id WHERE t.cancel_token = ?1`).bind(token),
  ]);
  const i = interest.results?.[0];
  if (i) return { table: 'event_interest', ...i };
  const t = team.results?.[0];
  return t ? { table: 'event_teams', ...t } : null;
}

/** Withdraw interest or a team; a team that frees a division's place moves the first waiting team up. */
export async function withdrawByToken(env, token) {
  const found = await lookupEventToken(env, token);
  if (!found) return { ok: false, code: 'not-found' };
  if (found.status === 'withdrawn') return { ok: false, code: 'already-cancelled', found };
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE ${found.table} SET status = 'withdrawn', updated_at = ?2 WHERE cancel_token = ?1 AND status != 'withdrawn'`
  ).bind(token, now).run();
  if (!res.meta?.changes) return { ok: false, code: 'already-cancelled', found };
  if (found.table === 'event_teams' && found.status === 'entered') {
    const next = await promoteTeam(env, found.id);
    if (next) await tellPromotedTeam(env, next); // sends only with EVENT_EMAILS_ENABLED
  }
  return { ok: true, found };
}

/** POST /api/events/:id/pay {token}: a fresh Checkout Session for a place held for payment. */
export async function handleEventPay(request, env, cors, id) {
  if (!cors['Access-Control-Allow-Origin']) return errorResponse('Requests from this origin are not allowed.', 403, cors);
  if (!flag(env, 'EVENTS_ENABLED', false) || !EVENT_ID_RE.test(id)) return errorResponse('No such event.', 404, cors);
  let body;
  try {
    body = await readJson(request, 4 * 1024);
  } catch {
    return errorResponse('We could not read that request.', 400, cors);
  }
  const site = (env.SITE_URL || 'https://tnsaints.com').replace(/\/$/, '');
  const pay = await payLinkCheckout(env, { eventId: id, token: String(body?.token || ''), site }).catch(() => ({ ok: false }));
  if (!pay.ok) return errorResponse('That place is no longer held for payment. Email info@tnsaints.com and we will help.', 409, cors);
  return json({ ok: true, checkout_url: pay.url }, { cors });
}
