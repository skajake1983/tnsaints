/**
 * Events (the Events plan, 2026-10-21, phase EV1): every event past and
 * upcoming, one event's sessions and sign-ups, its sign-ups as a CSV, and
 * choosing which event Roster, Evaluations and Decisions show.
 *
 *   GET  /events                          events:manage
 *   GET  /events/new, /events/new/form    events:manage (EV2: kind, then the prefilled form)
 *   POST /events/new                      events:manage (a hidden draft)
 *   POST /events/:id/{publish|close|archive|feature|unfeature|repeat}   events:manage
 *   GET  /events/:id                      events:manage
 *   GET  /events/:id/registrations.csv    roster:export (audited, counts only)
 *   POST /events/view                     roster:view (sets admin/event-choice.js's cookie)
 */

import { audit, can } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { toCsv } from '../../http.js';
import { page, htmlResponse, adminHeaders } from '../ui.js';
import { NAV, denyHtml, notFoundPage } from '../nav.js';
import { listEvents, withEvent, EVENT_ID_RE } from '../../programs/evaluation.js';
import { getAvailability } from '../../registration.js';
import { eventCookie } from '../event-choice.js';
import { eventsBody, eventBody, EVENT_STYLES, EVENT_FORM_STYLES, centralToday, newEventChooser, eventFormBody,
  eventManagePanel } from '../events-ui.js';
import { eventPrefill, readEventForm, createEvent, lastOfKind, setEventStatus, setFeatured, featuredEvent, repeatWeekly,
  KIND_DEFAULTS, EVENT_KIND_LIST, isoToCentral } from '../../events/manage.js';
import { eventPublicModel, KIND_LABEL } from '../../events/public.js';
import { listWaivers } from '../../programs/settings.js';
import { interestPanel, teamsPanel, invitationsPanel, invitePageBody, campaignBody, addressesBody } from '../events-ui.js';
import { audienceOptions, readAudience, audienceEmpty, buildAudience, createCampaign, readMessage, campaignSummary,
  listCampaigns, approveCampaign, cancelCampaign, bccChunks, sendEstimate, drainInvitations, SEND_NOW } from '../../events/invitations.js';
import { promoteTeam, tellPromotedTeam } from '../../events/payments.js';
import { sendInterestConfirmed } from '../../email.js';
import { flag } from '../../lib/flags.js';
import { seeOther } from '../nav.js';

const denyEvents = denyHtml('Events', 'Events are managed by admins.');
const RETURNS = new Set(['/', '/eval', '/decisions']);

/** Every event, marked with which is the current evaluation. */
export async function eventsWithCurrent(env) {
  const [events, current] = await Promise.all([
    listEvents(env),
    env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'evaluation.current'`).first(),
  ]);
  return events.map((e) => ({ ...e, is_current: Boolean(current && e.id === current.value) }));
}

/** env for one event: its program, or wrangler.toml's event when that is the one asked for. */
async function envFor(rcEnv, id) {
  const base = rcEnv.BASE ?? rcEnv;
  const ev = await withEvent(base, id);
  if (ev !== base) return ev;
  return id === base.EVENT_ID ? base : null;
}

/** An event, with what its invitation email shows about it. */
async function eventForInvite(env, id) {
  const events = await listEvents(env);
  const e = events.find((x) => x.id === id && !x.settings);
  if (!e) return null;
  const [found] = await env.DB.batch([
    env.DB.prepare(`SELECT *, COALESCE(event_kind, kind) AS shown_kind FROM programs WHERE id = ?1`).bind(id),
  ]);
  const row = found.results?.[0];
  const { results: groups } = await env.DB.prepare(
    `SELECT name, start_time, end_time, starts_on, capacity FROM program_groups WHERE program_id = ?1 AND status = 'active'`
  ).bind(id).all();
  const model = eventPublicModel({ ...row, kind: row.shown_kind }, groups || []);
  return { ...e, date_line: model.date_line, time_line: model.time_line, location: model.location };
}

async function invitePage(env, principal, base, id, params, { values = {}, errors = [] } = {}) {
  const ev = await eventForInvite(env, id);
  if (!ev) return notFoundPage(principal, 'No such event');
  const options = await audienceOptions(env, ev.id);
  const audience = readAudience(params, options);
  const result = audienceEmpty(audience) ? null : await buildAudience(env, ev.id, audience);
  const defaults = {
    subject: `You're invited: ${ev.name}`,
    message: `We'd love to see you at ${ev.name}${ev.date_line ? ` on ${ev.date_line}` : ''}.\n\nSign up with the button below. Places are limited.`,
  };
  return htmlResponse(page({ title: `Invite people: ${ev.name}`, principal, nav: NAV, current: '/events',
    extraStyles: EVENT_STYLES + EVENT_FORM_STYLES,
    body: invitePageBody({ base, event: ev, options, audience, result, values, errors, defaults }) }),
  { status: errors.length ? 400 : 200 });
}

function formPage(principal, base, v, waivers, errors = {}, status = 200) {
  const d = KIND_DEFAULTS[v.kind];
  return htmlResponse(page({ title: `New ${KIND_LABEL[v.kind]}`, principal, nav: NAV, current: '/events',
    extraStyles: EVENT_STYLES + EVENT_FORM_STYLES,
    body: eventFormBody({ base, v, errors, waivers, kindLabel: KIND_LABEL[v.kind], multiDay: Boolean(d?.multiDay) }) }), { status });
}

export const routes = [
  {
    method: 'GET', path: '/events/new', cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base }) => {
      const events = await listEvents(env);
      return htmlResponse(page({ title: 'New event', principal, nav: NAV, current: '/events',
        extraStyles: EVENT_STYLES + EVENT_FORM_STYLES, body: newEventChooser({ base, events: events.filter((e) => !e.settings) }) }));
    },
  },
  {
    method: 'GET', path: '/events/new/form', cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base, url }) => {
      const kind = String(url.searchParams.get('kind') || '');
      if (!EVENT_KIND_LIST.includes(kind)) return seeOther(base, '/events/new');
      const fromRaw = String(url.searchParams.get('from') || '');
      const from = fromRaw === 'last' ? (await lastOfKind(env, kind))?.id || '' : (EVENT_ID_RE.test(fromRaw) ? fromRaw : '');
      const [v, waivers] = await Promise.all([eventPrefill(env, kind, from), listWaivers(env)]);
      return formPage(principal, base, v, waivers);
    },
  },
  {
    method: 'POST', path: '/events/new', cap: 'events:manage', deny: denyEvents,
    handler: async ({ request, env, ctx, principal, base }) => {
      let form;
      try { form = await readForm(request); } catch { form = null; }
      if (!form) return seeOther(base, '/events/new');
      const waivers = await listWaivers(env);
      const read = readEventForm(form, waivers.map((w) => w.id));
      if (!read.ok) {
        if (read.errors.kind) return seeOther(base, '/events/new');
        // Re-show what was typed, in the form's own shape.
        const v = { ...read.value, opens: read.value.opens, closes: read.value.closes };
        return formPage(principal, base, v, waivers, read.errors, 400);
      }
      const made = await createEvent(env, read.value, principal.email);
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.created', subjectType: 'program', subjectId: made.id,
        detail: { kind: read.value.kind, sessions: read.value.sessions.length, from: read.value.from || null } }));
      return seeOther(base, `/events/${made.id}?msg=created`);
    },
  },
  {
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/(publish|close|archive|feature|unfeature|repeat)$/,
    cap: 'events:manage', deny: denyEvents,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const [, id, action] = m;
      const known = (await listEvents(env)).some((e) => e.id === id && !e.settings);
      if (!known) return notFoundPage(principal, 'No such event');
      let msg;
      if (action === 'feature' || action === 'unfeature') {
        msg = await setFeatured(env, action === 'feature' ? id : null, principal.email);
      } else if (action === 'repeat') {
        let form;
        try { form = await readForm(request); } catch { form = null; }
        const r = await repeatWeekly(env, id, Number(form?.get('weeks')));
        msg = r.result === 'repeated' ? 'repeated' : 'invalid';
        if (r.ids) ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.repeated', subjectType: 'program', subjectId: id,
          detail: { copies: r.ids.length } }));
      } else {
        msg = await setEventStatus(env, id, action);
      }
      if (['published', 'closed', 'archived', 'featured', 'unfeatured'].includes(msg)) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: `event.${msg}`, subjectType: 'program', subjectId: id }));
      }
      return seeOther(base, action === 'archive' && msg === 'archived' ? '/events' : `/events/${id}?msg=${msg}`);
    },
  },
  {
    // Confirm or decline someone who registered interest. Confirming emails them
    // only when event emails are switched on (EVENT_EMAILS_ENABLED).
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/interest\/(\d{1,12})\/(confirm|decline)$/,
    cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, ctx, principal, base }, m) => {
      const [, id, interestId, action] = m;
      const status = action === 'confirm' ? 'confirmed' : 'declined';
      const row = await env.DB.prepare(
        `UPDATE event_interest SET status = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5
          WHERE id = ?2 AND event_id = ?1 AND status IN ('interested', 'confirmed', 'declined') AND status != ?3
         RETURNING player_name, parent_email`
      ).bind(id, Number(interestId), status, principal.email, new Date().toISOString()).first();
      if (row) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: `event.interest_${status}`, subjectType: 'event_interest',
          subjectId: interestId }));
        if (status === 'confirmed' && flag(env, 'EVENT_EMAILS_ENABLED', false)) {
          const evEnv = await withEvent(env, id);
          ctx.waitUntil(sendInterestConfirmed(evEnv, { to: row.parent_email, playerName: row.player_name,
            event: { name: evEnv.EVENT_LABEL } }));
        }
      }
      return seeOther(base, `/events/${id}?msg=${row ? `interest-${status}` : 'invalid'}`);
    },
  },
  {
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/teams\/(\d{1,12})\/withdraw$/,
    cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, ctx, principal, base }, m) => {
      const [, id, teamId] = m;
      const row = await env.DB.prepare(
        `UPDATE event_teams SET status = 'withdrawn', updated_at = ?3 WHERE id = ?2 AND event_id = ?1 AND status != 'withdrawn'
         RETURNING id`
      ).bind(id, Number(teamId), new Date().toISOString()).first();
      if (row) {
        const next = await promoteTeam(env, Number(teamId));
        // The team moved up is told only while EVENT_EMAILS_ENABLED is "true" (sendEventPlaceOpened checks).
        if (next) ctx.waitUntil(tellPromotedTeam(env, next).catch(() => {}));
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.team_withdrawn', subjectType: 'event_team', subjectId: teamId }));
      }
      return seeOther(base, `/events/${id}?msg=${row ? 'team-withdrawn' : 'invalid'}`);
    },
  },
  {
    // Who to invite (counted live) and what to say; saving makes a draft.
    method: 'GET', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invite$/, cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base, url }, m) => invitePage(env, principal, base, m[1], url.searchParams),
  },
  {
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invite$/, cap: 'events:manage', deny: denyEvents,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      let form;
      try { form = await readForm(request); } catch { form = null; }
      if (!form) return seeOther(base, `/events/${m[1]}/invite`);
      const ev = await eventForInvite(env, m[1]);
      if (!ev) return notFoundPage(principal, 'No such event');
      const options = await audienceOptions(env, ev.id);
      const audience = readAudience(form, options);
      const words = readMessage(form);
      const result = audienceEmpty(audience) ? null : await buildAudience(env, ev.id, audience);
      if (words.errors.length || !result || !result.people.length) {
        return invitePage(env, principal, base, ev.id, form, { values: words, errors: words.errors.length ? words.errors
          : ['There is nobody to invite with that choice.'] });
      }
      const id = await createCampaign(env, { eventId: ev.id, subject: words.subject, message: words.message, audience,
        people: result.people, actor: principal.email });
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.invite_drafted', subjectType: 'invite_campaign', subjectId: id,
        detail: { event: ev.id, people: result.people.length } }));
      return seeOther(base, `/events/${ev.id}/invites/${id}?msg=created`);
    },
  },
  {
    method: 'GET', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invites\/(\d{1,12})$/, cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base, url }, m) => {
      const ev = await eventForInvite(env, m[1]);
      const summary = ev && await campaignSummary(env, ev.id, Number(m[2]));
      if (!summary) return notFoundPage(principal, 'No such invitation');
      const estimate = await sendEstimate(env, summary.counts.held + summary.counts.queued);
      return htmlResponse(page({ title: summary.campaign.subject, principal, nav: NAV, current: '/events',
        extraStyles: EVENT_STYLES + EVENT_FORM_STYLES,
        body: campaignBody({ base, event: ev, summary, estimate, msg: url.searchParams.get('msg'),
          canApprove: can(principal, 'messages:approve'), canSend: can(principal, 'messages:send'),
          canExport: can(principal, 'crm:export'), invitesOn: flag(env, 'INVITES_ENABLED', false),
          mailingAddress: String(env.MAILING_ADDRESS || '').trim() }) }));
    },
  },
  {
    // Approving is the owner's consent to send (the owner, 2026-10-21).
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invites\/(\d{1,12})\/approve$/, cap: 'messages:approve',
    deny: denyEvents,
    handler: async ({ env, ctx, principal, base }, m) => {
      const result = await approveCampaign(env, m[1], Number(m[2]), principal.email);
      if (result === 'approved') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.invite_approved', subjectType: 'invite_campaign', subjectId: m[2] }));
      }
      return seeOther(base, `/events/${m[1]}/invites/${m[2]}?msg=${result}`);
    },
  },
  {
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invites\/(\d{1,12})\/send$/, cap: 'messages:send', deny: denyEvents,
    handler: async ({ env, ctx, principal, base }, m) => {
      const back = (msg) => seeOther(base, `/events/${m[1]}/invites/${m[2]}?msg=${msg}`);
      const campaign = await env.DB.prepare(`SELECT status FROM invite_campaigns WHERE id = ?1 AND event_id = ?2`)
        .bind(Number(m[2]), m[1]).first();
      if (!campaign) return back('invalid');
      // Only an approved invitation sends (drainInvitations checks it again).
      if (campaign.status !== 'approved') return back('not-approved');
      const r = await drainInvitations(env, { limit: SEND_NOW, campaignId: Number(m[2]) });
      if (r.skipped) return back(r.skipped === 'no-address' ? 'needs-address' : 'disabled');
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.invite_sent', subjectType: 'invite_campaign', subjectId: m[2],
        detail: { sent: r.sent || 0, failed: r.failed || 0 } }));
      return back(r.sent ? 'sent' : r.stopped === 'budget' ? 'budget' : r.failed ? 'failed' : 'none-left');
    },
  },
  {
    method: 'POST', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invites\/(\d{1,12})\/cancel$/, cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, ctx, principal, base }, m) => {
      const result = await cancelCampaign(env, m[1], Number(m[2]));
      if (result === 'cancelled') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.invite_cancelled', subjectType: 'invite_campaign', subjectId: m[2] }));
      }
      return seeOther(base, `/events/${m[1]}/invites/${m[2]}?msg=${result}`);
    },
  },
  {
    // The same people, for an Outlook BCC instead (crm:export; counted in the audit, never listed).
    method: 'GET', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/invites\/(\d{1,12})\/addresses$/, cap: 'crm:export',
    deny: denyHtml('Events', 'Copying addresses needs CRM export access.'),
    handler: async ({ env, ctx, principal, base }, m) => {
      const ev = await eventForInvite(env, m[1]);
      if (!ev) return notFoundPage(principal, 'No such event');
      const { results } = await env.DB.prepare(
        `SELECT email FROM event_invitations WHERE campaign_id = ?1 AND event_id = ?2 AND email IS NOT NULL
            AND send_state IN ('held', 'queued', 'sent') ORDER BY id`
      ).bind(Number(m[2]), ev.id).all();
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'event.invite_addresses_copied', subjectType: 'invite_campaign',
        subjectId: m[2], detail: { count: (results || []).length } }));
      return htmlResponse(page({ title: 'Addresses for Outlook', principal, nav: NAV, current: '/events',
        extraStyles: EVENT_STYLES + EVENT_FORM_STYLES,
        body: addressesBody({ base, event: ev, campaignId: m[2], chunks: bccChunks(results || []), count: (results || []).length }) }));
    },
  },
  {
    method: 'GET', path: '/events', cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base }) => {
      const events = await eventsWithCurrent(env);
      return htmlResponse(page({ title: 'Events', principal, nav: NAV, current: '/events', extraStyles: EVENT_STYLES,
        body: eventsBody({ events, base, canManage: can(principal, 'events:manage'), today: centralToday() }) }));
    },
  },
  {
    method: 'GET', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})$/, cap: 'events:manage', deny: denyEvents,
    handler: async ({ env, principal, base, url }, m) => {
      const events = await eventsWithCurrent(env);
      const event = events.find((e) => e.id === m[1] && !e.settings);
      const ev = event && await envFor(env, event.id);
      if (!ev) return notFoundPage(principal, 'No such event');
      const [availability, statuses, rows, featured] = await Promise.all([
        getAvailability(ev),
        ev.DB.prepare(`SELECT status, session_time, COUNT(*) AS n FROM registrations WHERE event_id = ?1 GROUP BY status, session_time`)
          .bind(event.id).all(),
        env.DB.batch([
          env.DB.prepare(`SELECT *, COALESCE(event_kind, kind) AS shown_kind FROM programs WHERE id = ?1`).bind(event.id),
          env.DB.prepare(`SELECT name, start_time, end_time, starts_on, capacity FROM program_groups WHERE program_id = ?1
                           AND status = 'active' ORDER BY starts_on IS NULL, starts_on, start_time IS NULL, start_time, name`).bind(event.id),
        ]),
        featuredEvent(env),
      ]);
      const campaigns = await listCampaigns(env, event.id);
      const [interest, teams] = await env.DB.batch([
        env.DB.prepare(`SELECT id, player_name, grade, parent_name, parent_email, phone, notes, status FROM event_interest
                         WHERE event_id = ?1 ORDER BY status = 'withdrawn', created_at`).bind(event.id),
        env.DB.prepare(`SELECT t.id, t.team_name, g.name AS division, t.coach_name, t.coach_email, t.coach_phone, t.players_count,
                               t.status FROM event_teams t JOIN program_groups g ON g.id = t.group_id
                         WHERE t.event_id = ?1 ORDER BY t.status = 'withdrawn', g.name, t.created_at`).bind(event.id),
      ]);
      const row = rows[0].results?.[0];
      const program = { ...row, kind: row.shown_kind };
      const full = new Map(availability.sessions.map((s) => [s.session_time, s.full]));
      const model = eventPublicModel(program, (rows[1].results || []).map((g) => ({ ...g, full: full.get(g.name) })));
      const location = ev.EVENT_LOCATION || '';
      const counts = { confirmed: 0, waitlist: 0, cancelled: 0, waitingBySession: {} };
      for (const r of statuses.results || []) {
        counts[r.status] = (counts[r.status] || 0) + Number(r.n);
        if (r.status === 'waitlist') counts.waitingBySession[r.session_time] = Number(r.n);
      }
      return htmlResponse(page({ title: event.name, principal, nav: NAV, current: '/events', extraStyles: EVENT_STYLES + EVENT_FORM_STYLES,
        body: eventBody({ event: { ...event, location }, sessions: availability.sessions, counts, base,
          canExport: can(principal, 'roster:export'), isCurrent: event.is_current,
          manage: eventManagePanel({ base, event, model, featured: featured === event.id, msg: url.searchParams.get('msg') }),
          extra: event.signup_mode === 'interest' || (interest.results || []).length
            ? interestPanel({ base, eventId: event.id, rows: interest.results || [], emails: flag(env, 'EVENT_EMAILS_ENABLED', false) })
            : event.signup_mode === 'team' ? teamsPanel({ base, eventId: event.id, rows: teams.results || [] }) : '',
          invitations: invitationsPanel({ base, eventId: event.id, campaigns }) }) }));
    },
  },
  {
    // The same columns as the token export (index.js handleAdminExport), less
    // the capabilities: no cancel tokens, and a flag instead of medical text.
    method: 'GET', path: /^\/events\/([a-z0-9][a-z0-9-]{0,59})\/registrations\.csv$/, cap: 'roster:export',
    deny: denyHtml('Events', 'Exporting sign-ups needs roster export access.'),
    handler: async ({ env, ctx, principal }, m) => {
      const id = m[1];
      const known = (await listEvents(env)).some((e) => e.id === id);
      if (!known) return notFoundPage(principal, 'No such event');
      const { results } = await env.DB.prepare(
        `SELECT id, session_time, status, player_name, grade, years_experience, parent_name, parent_email, phone, school,
                emergency_contact_name, emergency_contact_phone,
                CASE WHEN medical_notes IS NOT NULL AND TRIM(medical_notes) != '' THEN 1 ELSE 0 END AS has_medical_notes,
                photo_release, signed_at, created_at, cancelled_at, payment_state, amount_due_cents
           FROM registrations WHERE event_id = ?1 ORDER BY session_time, status DESC, id`
      ).bind(id).all();
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'roster.export', subjectType: 'event', subjectId: id,
        detail: { count: (results || []).length, format: 'csv', via: 'admin' } }));
      return new Response(toCsv(results || []), {
        headers: adminHeaders({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="tnsaints-${id}.csv"`,
        }),
      });
    },
  },
  {
    method: 'POST', path: '/events/view', cap: 'roster:view',
    handler: async ({ request, env, base }) => {
      let form;
      try { form = await readForm(request); } catch { form = null; }
      const id = String(form?.get('event') || '');
      const back = String(form?.get('return') || '/');
      const to = RETURNS.has(back) ? back : '/';
      // Only an event staff can already see; anything else clears the choice.
      const ok = EVENT_ID_RE.test(id) && (await listEvents(env)).some((e) => e.id === id);
      return new Response(null, {
        status: 303,
        headers: adminHeaders({ Location: `${base}${to}`, 'Set-Cookie': eventCookie(ok ? id : null) }),
      });
    },
  },
];
