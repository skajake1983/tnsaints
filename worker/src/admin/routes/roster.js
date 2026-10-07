/**
 * The evaluation roster, the signed-in profile, and the audited medical read.
 *
 * `/` and `/api/roster` require roster:view. Before the route table they
 * required only a staff login, so any role added later -- a board member, say
 * -- would have read every child's name. Every role today carries
 * roster:view, so nobody loses anything.
 */

import { json } from '../../http.js';
import { can, audit, rosterView } from '../../auth/staff.js';
import { getAvailability, registrationWindow, slotCapacity, sessionTimes } from '../../registration.js';
import { page, esc, htmlResponse, adminHeaders } from '../ui.js';
import { rowActions, registrationTemplate, fmtRegDate, ROSTER_STYLES, ROSTER_MARKUP, ROSTER_SCRIPT, rosterCsp } from '../roster-ui.js';
import { NAV, denyHtml, denyJson, seeOther } from '../nav.js';

const denyRoster = denyHtml('Roster', 'The roster is limited to staff with roster access.');

export const routes = [
  {
    method: 'GET', path: '/', cap: 'roster:view',
    // A board member has no roster; their home is the board.
    deny: (rc) => (can(rc.principal, 'board:view') ? seeOther(rc.base, '/board') : denyRoster(rc)),
    handler: ({ env, principal }) => renderRoster(env, principal),
  },
  {
    method: 'GET', path: '/profile', cap: 'staff',
    handler: ({ principal }) => renderWhoami(principal),
  },
  // JSON sibling of the roster page, same projection. Useful for a quick pull
  // from a phone and, later, for the notes UI to fetch against.
  {
    method: 'GET', path: '/api/roster', cap: 'roster:view',
    deny: denyJson('The roster is limited to staff with roster access.'),
    handler: async ({ env, principal }) => {
      const rows = await rosterView(env, principal);
      return json({ ok: true, count: rows.length, registrations: rows });
    },
  },
  {
    method: 'GET', path: '/api/health', cap: 'staff',
    handler: ({ principal }) => json({ ok: true, principal: principal.email, role: principal.role }),
  },
  // A medical note is a real safety need on event day and the most sensitive
  // field in the database. Resolved by ACCESS PATH rather than by widening the
  // coach role: everyone sees a flag saying a note exists, reading the text is
  // admin-only, and every read leaves an audit row naming who read whose.
  //
  // Deliberately not folded into the roster projection even for admins. A
  // field that arrives with the page gets read by nobody in particular and
  // audits as one bulk event; a field you have to ask for audits as an
  // intentional act, which is what makes the log worth keeping.
  {
    method: 'GET', path: /^\/api\/roster\/(\d+)\/medical$/, cap: 'roster:medical',
    // Audited even when refused. An attempt to read fifty medical notes by a
    // role that cannot is exactly the pattern worth being able to see later.
    deny: ({ env, ctx, principal }, m) => {
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'medical.denied',
          subjectType: 'registration',
          subjectId: Number(m[1]),
          detail: { role: principal.role },
        })
      );
      return json({ ok: false, error: 'Medical notes are limited to academy admins. Ask Jacob.' }, { status: 403 });
    },
    handler: ({ env, ctx, principal }, m) => handleMedicalRead(env, ctx, principal, Number(m[1])),
  },
];

async function handleMedicalRead(env, ctx, principal, registrationId) {
  const row = await env.DB.prepare(
    `SELECT id, player_name, medical_notes
       FROM registrations
      WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!row) {
    return json({ ok: false, error: 'No such registration.' }, { status: 404 });
  }

  // The audit records WHICH note was read and by whom, never WHAT it said.
  // Copying the text into audit_log would put the most sensitive field in the
  // database into a second table with different access rules — the precise
  // thing logging the access was meant to avoid.
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'medical.read',
      subjectType: 'registration',
      subjectId: registrationId,
      detail: { had_note: Boolean(row.medical_notes) },
    })
  );

  return json({
    ok: true,
    registration_id: row.id,
    player_name: row.player_name,
    medical_notes: row.medical_notes || null,
  });
}

function renderWhoami(principal) {
  return htmlResponse(
    page({
      title: 'Profile',
      principal,
      nav: NAV,
      current: '/profile',
      body: `
  <h1>Signed in</h1>
  <p class="sub">What this account can see and do.</p>
  <div class="panel"><div class="scroll"><table>
    <tbody>
      <tr><th>Email</th><td>${esc(principal.email)}</td></tr>
      <tr><th>Name</th><td>${esc(principal.displayName)}</td></tr>
      <tr><th>Credited to parents as</th><td>${esc(principal.authorLabel)}</td></tr>
      <tr><th>Role</th><td>${esc(principal.role)}</td></tr>
      <tr><th>Contact details</th><td>${can(principal, 'roster:contact') ? 'visible' : 'hidden'}</td></tr>
      <tr><th>Medical notes</th><td>${can(principal, 'roster:medical') ? 'readable (audited)' : 'flag only'}</td></tr>
    </tbody>
  </table></div></div>`,
    })
  );
}

async function renderRoster(env, principal) {
  const [rows, availability] = await Promise.all([
    rosterView(env, principal),
    getAvailability(env),
  ]);

  const window = registrationWindow(env);
  const capacity = slotCapacity(env);
  const times = sessionTimes(env);

  const count = (time, status) =>
    rows.filter((r) => r.session_time === time && r.status === status).length;

  const confirmed = rows.filter((r) => r.status === 'confirmed').length;
  const waitlisted = rows.filter((r) => r.status === 'waitlist').length;
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const medical = rows.filter((r) => r.has_medical_notes === 1).length;

  const showsContact = can(principal, 'roster:contact');

  const cards = [
    { n: `${confirmed} / ${capacity * times.length}`, l: 'Confirmed' },
    { n: waitlisted, l: 'Waiting list' },
    { n: cancelled, l: 'Cancelled' },
    { n: medical, l: 'Medical note on file' },
  ]
    .map((c) => `<div class="card"><div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`)
    .join('');

  const sessionRows = times
    .map((t) => {
      const c = count(t, 'confirmed');
      const w = count(t, 'waitlist');
      const full = availability.sessions.find((s) => s.session_time === t)?.full;
      return `<tr>
        <td data-label="Session"><strong>${esc(t)}</strong></td>
        <td data-label="Confirmed">${c} of ${capacity}</td>
        <td data-label="Availability">${full ? '<span class="pill waitlist">full</span>' : `<span class="pill confirmed">${capacity - c} open</span>`}</td>
        <td data-label="Waiting list">${w} waiting</td>
      </tr>`;
    })
    .join('');

  const canReadMedical = can(principal, 'roster:medical');

  // A deliberately narrow set of columns: enough to find a player at a glance,
  // and nothing so wide that the table needs a horizontal scrollbar. Everything
  // else about a registration is one "View registration" click away, in a
  // vertical detail modal. Parent NAME is shown to every role; the means of
  // reaching the parent (email, phone) stays admin-only, in the detail.
  const headers = ['Player', 'Grade', 'Session', 'Parent', 'Registered', 'Status', '']
    .map((h) => `<th>${esc(h)}</th>`)
    .join('');

  const body = rows.length
    ? rows
        .map((r) => {
          return `<tr>
        <td data-label="Player"><strong>${esc(r.player_name)}</strong></td>
        <td data-label="Grade">${esc(r.grade)}</td>
        <td data-label="Session">${esc(r.session_time)}</td>
        <td data-label="Parent">${esc(r.parent_name)}</td>
        <td data-label="Registered">${esc(fmtRegDate(r.created_at))}</td>
        <td data-label="Status"><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
        <td data-label="">${rowActions(r, canReadMedical)}</td>
      </tr>`;
        })
        .join('')
    : '';

  // One hidden <template> per row holding the full, role-appropriate detail; the
  // View button clones the matching one into the modal.
  const detailTemplates = rows
    .map((r) => registrationTemplate(r, showsContact, canReadMedical))
    .join('');

  const table = rows.length
    ? `<div class="scroll"><table class="stack"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>${detailTemplates}`
    : `<div class="empty">No registrations yet for this event.</div>`;

  const windowNote = window.open
    ? `Registration is open until ${esc(new Date(window.closesAt).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} Central.`
    : 'Registration is closed.';

  const html = page({
    title: 'Roster',
    principal,
    nav: NAV,
    current: '/',
    extraStyles: ROSTER_STYLES,
    body: `
  <h1>${esc(env.EVENT_LABEL || env.EVENT_ID)}</h1>
  <p class="sub">${windowNote}${env.EVALUATION_SOURCE === 'program'
    ? ` Running from the evaluation program <a href="programs/${esc(env.EVENT_ID)}">${esc(env.EVENT_ID)}</a>.`
    : ' Running from the settings in wrangler.toml.'}</p>

  <div class="cards">${cards}</div>

  <div class="panel">
    <h2>Sessions</h2>
    <div class="scroll"><table class="stack">
      <thead><tr><th>Session</th><th>Confirmed</th><th>Availability</th><th>Waiting list</th></tr></thead>
      <tbody>${sessionRows}</tbody>
    </table></div>
  </div>

  <div class="panel">
    <h2>Registrations</h2>
    ${table}
  </div>

  ${
    showsContact
      ? ''
      : `<div class="notice">Contact details and medical notes are not shown to this role.
         If you need to reach a family, or a player has a medical note, ask Jacob.</div>`
  }

  ${ROSTER_MARKUP}

  <script>${ROSTER_SCRIPT}</script>`,
  });

  // Served with the roster CSP so the reveal script (hash-pinned) can run. The
  // medical-note read it triggers is audited server-side.
  return new Response(html, {
    headers: adminHeaders({ 'Content-Security-Policy': await rosterCsp() }),
  });
}
