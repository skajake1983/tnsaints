/**
 * The admin surface, served on its own hostname.
 *
 * WHY A HOSTNAME AND NOT api.tnsaints.com/admin
 * ----------------------------------------------
 * Same Worker, same D1, same-origin fetch — the split is not about
 * infrastructure. It is about which way a mistake fails.
 *
 * api.tnsaints.com must keep /api/register and /api/availability public
 * forever, so any Access application on that hostname is necessarily
 * path-scoped. Path-scoped policies fail OPEN: add /api/staff/... in six
 * months, forget to widen the include rule, and it is on the public internet
 * serving children's medical notes with no error anywhere. admin.tnsaints.com/*
 * fails CLOSED — a path nobody thought about is still behind the door.
 *
 * The decisive argument is blast radius. A fat-fingered Access policy on
 * api.tnsaints.com during a live campaign breaks parent registration. On a
 * separate hostname the same mistake breaks only the dashboard, and families
 * signing up never notice.
 *
 * It also keeps /api/stripe/webhook reachable later: Stripe cannot do SSO, so
 * on a path-scoped app you would be carving an exception into the policy you
 * just wrote.
 */

import { json } from '../http.js';
import { verifyAccessJwt, devPrincipalEmail } from '../auth/access.js';
import { loadStaff, can, audit, rosterView } from '../auth/staff.js';
import { getAvailability, registrationWindow, slotCapacity, sessionTimes } from '../registration.js';
import { page, esc, htmlResponse, notAuthorisedPage } from './ui.js';

const NAV = [
  { href: '/', label: 'Roster' },
  { href: '/whoami', label: 'Who am I' },
];

/**
 * Everything on this hostname is gated. There is no public path here by
 * design — see the module comment on failing closed.
 */
export async function handleAdmin(request, env, ctx, path) {
  const url = new URL(request.url);
  // Resolved by the dispatcher, which strips the local development prefix. Do
  // not read url.pathname directly here — that would make every route below
  // wrong under local dev, which is exactly where they get tested.
  const pathname = path || url.pathname;

  // Local development only — see devPrincipalEmail(). Null in production.
  const devEmail = devPrincipalEmail(request, env);
  const verified = devEmail
    ? { ok: true, email: devEmail, sub: 'dev', claims: {} }
    : await verifyAccessJwt(request, env);

  if (!verified.ok) {
    // 401 rather than 403: the visitor has not proven who they are. In normal
    // operation this is unreachable, because Access redirects to login before
    // the request ever arrives — reaching it means either a direct hit that
    // bypassed the Access app, or a misconfiguration. Both are worth seeing.
    const detail =
      verified.reason === 'misconfigured'
        ? 'This admin app is not fully configured yet. Contact Jacob.'
        : 'Sign in through the Tennessee Saints staff login to continue.';

    return htmlResponse(
      page({
        title: 'Sign in required',
        body: `<h1>Sign in required</h1><p class="sub">${esc(detail)}</p>`,
      }),
      { status: 401 }
    );
  }

  const principal = await loadStaff(env, verified.email);

  if (!principal) {
    // Authenticated, not authorised. This is the control that survives someone
    // widening the Access policy: being admitted through the door is not the
    // same as being on the staff list.
    console.warn(
      JSON.stringify({ event: 'admin_denied_not_staff', email_domain: verified.email.split('@')[1] })
    );
    ctx.waitUntil(
      audit(env, {
        actor: verified.email,
        action: 'admin.denied',
        detail: { reason: 'not-in-staff' },
      })
    );
    return htmlResponse(notAuthorisedPage(verified.email), { status: 403 });
  }

  if (pathname === '/' && request.method === 'GET') {
    return await renderRoster(env, principal);
  }

  if (pathname === '/whoami' && request.method === 'GET') {
    return renderWhoami(principal);
  }

  // JSON sibling of the roster page, same projection. Useful for a quick pull
  // from a phone and, later, for the notes UI to fetch against.
  if (pathname === '/api/roster' && request.method === 'GET') {
    const rows = await rosterView(env, principal);
    return json({ ok: true, count: rows.length, registrations: rows });
  }

  if (pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, principal: principal.email, role: principal.role });
  }

  // A medical note is a real safety need on event day and the most sensitive
  // field in the database. Resolved by ACCESS PATH rather than by widening the
  // coach role: everyone sees a flag saying a note exists, reading the text is
  // admin-only, and every read leaves an audit row naming who read whose.
  //
  // Deliberately not folded into the roster projection even for admins. A
  // field that arrives with the page gets read by nobody in particular and
  // audits as one bulk event; a field you have to ask for audits as an
  // intentional act, which is what makes the log worth keeping.
  const medical = pathname.match(/^\/api\/roster\/(\d+)\/medical$/);
  if (medical && request.method === 'GET') {
    return await handleMedicalRead(env, ctx, principal, Number(medical[1]));
  }

  return htmlResponse(
    page({
      title: 'Not found',
      principal,
      nav: NAV,
      body: `<h1>Not found</h1><p class="sub">No admin page at ${esc(pathname)}.</p>`,
    }),
    { status: 404 }
  );
}

async function handleMedicalRead(env, ctx, principal, registrationId) {
  if (!can(principal, 'roster:medical')) {
    // Audited even when refused. An attempt to read fifty medical notes by a
    // role that cannot is exactly the pattern worth being able to see later.
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'medical.denied',
        subjectType: 'registration',
        subjectId: registrationId,
        detail: { role: principal.role },
      })
    );
    return json(
      { ok: false, error: 'Medical notes are limited to academy admins. Ask Jacob.' },
      { status: 403 }
    );
  }

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
      title: 'Who am I',
      principal,
      nav: NAV,
      current: '/whoami',
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
        <td><strong>${esc(t)}</strong></td>
        <td>${c} of ${capacity}</td>
        <td>${full ? '<span class="pill waitlist">full</span>' : `<span class="pill confirmed">${capacity - c} open</span>`}</td>
        <td>${w} waiting</td>
      </tr>`;
    })
    .join('');

  const headers = ['Player', 'Grade', 'Yrs', 'Session', 'Status', 'School']
    .concat(showsContact ? ['Parent', 'Email', 'Phone'] : [])
    .concat(['Flags'])
    .map((h) => `<th>${esc(h)}</th>`)
    .join('');

  const body = rows.length
    ? rows
        .map((r) => {
          const contact = showsContact
            ? `<td>${esc(r.parent_name)}</td><td>${esc(r.parent_email)}</td><td>${esc(r.phone)}</td>`
            : '';
          // The flag, never the text. A coach needs to know the note exists;
          // reading it goes through the audited admin endpoint.
          const flag = r.has_medical_notes
            ? '<span class="med">medical note — see Jacob</span>'
            : '';
          return `<tr>
        <td><strong>${esc(r.player_name)}</strong></td>
        <td>${esc(r.grade)}</td>
        <td>${esc(r.years_experience ?? '')}</td>
        <td>${esc(r.session_time)}</td>
        <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
        <td>${esc(r.school)}</td>
        ${contact}
        <td>${flag}</td>
      </tr>`;
        })
        .join('')
    : '';

  const table = rows.length
    ? `<div class="scroll"><table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty">No registrations yet for this event.</div>`;

  const windowNote = window.open
    ? `Registration is open until ${esc(new Date(window.closesAt).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} Central.`
    : 'Registration is closed.';

  return htmlResponse(
    page({
      title: 'Roster',
      principal,
      nav: NAV,
      current: '/',
      body: `
  <h1>${esc(env.EVENT_LABEL || env.EVENT_ID)}</h1>
  <p class="sub">${windowNote}</p>

  <div class="cards">${cards}</div>

  <div class="panel">
    <h2>Sessions</h2>
    <div class="scroll"><table>
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
  }`,
    })
  );
}
