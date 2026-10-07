/**
 * Programs for families: what is open, and signing a child up.
 *
 * GET  /programs                              every open program, its groups and seats,
 *                                             and for each child what they can do
 * GET  /children/:id/register/:program        self-serve sign-up: choose a group, sign
 * POST /children/:id/register/:program        hold the seat (or confirm a free one),
 *                                             or join the waiting list if it is full
 *
 * Approval programs (the academy) still go through /children/:id/apply/:program
 * (apply.js): a family applies and staff offer a seat. Self-serve programs
 * (camps, clinics) skip the decision but not the rule: a seat in a scheduled
 * group is held before anyone pays (programs/selfserve.js).
 */

import { esc, portalPage, portalResponse, errorSummary, notFoundResponse } from './ui.js';
import { redirect } from './auth-pages.js';
import { getChild } from './data.js';
import { waiverSection, validateApplication } from './apply.js';
import {
  getProgram, listGroups, currentWaiver, programOpen, applicationBlockers, liveEnrollment, priceLine, enrollmentEnabled,
} from '../programs/enrollment.js';
import { register, joinWaitlist, HOLD_MINUTES } from '../programs/selfserve.js';
import { hashIp, clientIp } from '../http.js';
import { audit } from '../auth/staff.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';

const NAV = [{ href: '/', label: 'Family' }, { href: '/programs', label: 'Programs' }, { href: '/account', label: 'Account' }];
const KIND = { academy: 'Academy', camp: 'Camp', clinic: 'Clinic', tournament: 'Tournament', team: 'Team', evaluation: 'Evaluation' };
const LIVE = ['applied', 'waitlist', 'offered', 'active', 'past_due'];
const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;

function page(rc, title, body, status = 200) {
  return portalResponse(portalPage({ rc, title, body, nav: NAV, current: '/programs', signedIn: true }), { status });
}

const shortDate = (v) => new Date(v).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' });

/** Open programs families can see, with their active groups. */
async function catalog(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM programs WHERE status = 'open' AND public = 1
      ORDER BY kind = 'academy' DESC, registration_closes_at IS NULL, registration_closes_at, name LIMIT 50`
  ).all();
  const programs = (results || []).filter((p) => programOpen(p));
  const groups = await Promise.all(programs.map((p) => listGroups(env, p.id)));
  return programs.map((p, i) => ({ ...p, groups: groups[i].filter((g) => g.status === 'active') }));
}

function childAction(rc, child, program, enrollments) {
  const e = enrollments.find((x) => Number(x.player_id) === Number(child.id) && x.program_id === program.id && LIVE.includes(x.status));
  if (e) {
    if (e.status === 'offered') return `<a class="btn secondary" href="${esc(rc.url(`/pay/${e.ref}`))}">Finish paying</a>`;
    const label = { applied: 'Applied', waitlist: 'On the waiting list', active: 'Signed up', past_due: 'Payment needed' }[e.status];
    return `<span class="badge ok">${esc(label)}</span>`;
  }
  const grade = currentGrade(child.grade_level, child.grade_school_year);
  if (grade !== null && ((program.grade_min !== null && grade < program.grade_min) || (program.grade_max !== null && grade > program.grade_max))) {
    return '<span class="item-sub">Not for this grade</span>';
  }
  const verb = program.enrollment_mode === 'self_serve' ? 'register' : 'apply';
  const text = program.enrollment_mode === 'self_serve' ? 'Sign up' : 'Apply';
  return `<a class="btn secondary" href="${esc(rc.url(`/children/${child.id}/${verb}/${program.id}`))}">${text}</a>`;
}

/** GET /programs */
export async function catalogPage(env, rc, session) {
  const [programs, children, enrollments] = await Promise.all([
    catalog(env),
    env.DB.prepare(`SELECT id, display_name, grade_level, grade_school_year FROM players
                     WHERE household_id IN (${MEMBER_OF}) ORDER BY display_name`).bind(session.accountId).all(),
    env.DB.prepare(`SELECT id, ref, player_id, program_id, status FROM enrollments WHERE household_id IN (${MEMBER_OF})`)
      .bind(session.accountId).all(),
  ]);
  const kids = children.results || [];
  const places = enrollments.results || [];
  const list = programs.length
    ? programs.map((p) => {
      const range = p.grade_min !== null && p.grade_max !== null
        ? `Grades ${p.grade_min === 0 ? 'K' : p.grade_min}–${p.grade_max}` : '';
      const closes = p.registration_closes_at ? `Sign-up closes ${shortDate(p.registration_closes_at)}` : '';
      return `<section class="panel" aria-labelledby="p-${esc(p.id)}">
  <h2 id="p-${esc(p.id)}" style="margin-top:0">${esc(p.name)} <span class="badge">${esc(KIND[p.kind] || p.kind)}</span></h2>
  ${p.description ? `<p>${esc(p.description)}</p>` : ''}
  <p class="hint">${esc([range, priceLine(p), closes].filter(Boolean).join(' · '))}</p>
  ${p.groups.length ? `<ul class="plain">${p.groups.map((g) => {
    const left = Number(g.capacity) - Number(g.taken);
    return `<li><strong>${esc(g.name)}</strong> — ${esc(g.schedule_summary)}${g.location ? `, ${esc(g.location)}` : ''}${
      g.starts_on ? `, from ${esc(shortDate(`${g.starts_on}T17:00:00Z`))}` : ''} · ${left > 0 ? `${left} ${left === 1 ? 'place' : 'places'} left` : 'Full'}</li>`;
  }).join('')}</ul>` : ''}
  ${kids.length ? `<ul class="cards-list">${kids.map((c) => `<li class="item"><div><span class="item-title">${esc(c.display_name)}</span></div>
    ${childAction(rc, c, p, places)}</li>`).join('')}</ul>` : `<p><a href="${esc(rc.url('/'))}">Add a child</a> to sign up.</p>`}
</section>`;
    }).join('')
    : '<p>Nothing is open for sign-up right now. We will email families when the next program opens.</p>';
  return page(rc, 'Programs', `<h1>Programs</h1>
<p class="lede">What is open now. Places are only ever paid for once a seat in a scheduled group is yours.</p>
${list}`);
}

function registerPage(rc, { child, program, groups, waiver, blockers = [], existing = null, values = {}, errors = [], status = 200, notice = '' }) {
  const grade = currentGrade(child.grade_level, child.grade_school_year);
  const head = `<p><a href="${esc(rc.url('/programs'))}">&larr; All programs</a></p>
<h1>Sign up: ${esc(program.name)}</h1>
<p class="lede">For ${esc(child.display_name)}${grade !== null ? `, ${esc(gradeLabel(grade))}` : ''}. ${esc(priceLine(program))}</p>`;
  if (existing) {
    return page(rc, program.name, `${head}<div class="notice" role="status">${esc(child.display_name)} is already signed up
or waiting. You can see where it stands on your family page.</div>`, status);
  }
  if (blockers.length) {
    return page(rc, program.name, `${head}<section class="panel"><h2 style="margin-top:0">Before you sign up</h2>
<p>We need a few details first:</p><ul>${blockers.map((b) => `<li>${b.href ? `<a href="${esc(rc.url(b.href))}">${esc(b.message)}</a>` : esc(b.message)}</li>`).join('')}</ul></section>`, status);
  }
  const chosen = String(values.group || '');
  const paid = program.billing !== 'free';
  const options = groups.map((g) => {
    const full = Number(g.taken) >= Number(g.capacity);
    const disabled = full && !program.waitlist_enabled;
    return `<label class="choice"><input type="radio" name="group" value="${esc(g.id)}"${chosen === String(g.id) ? ' checked' : ''}${disabled ? ' disabled' : ''}>
  <span><strong>${esc(g.name)}</strong> — ${esc(g.schedule_summary)}${g.location ? `, ${esc(g.location)}` : ''}${
    full ? (program.waitlist_enabled ? ' <span class="badge warn">Full — choose to join the waiting list</span>' : ' <span class="badge warn">Full</span>') : ''}</span></label>`;
  }).join('');
  const groupError = errors.find((e) => e.id === 'group');
  const body = `${head}
${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
${errorSummary(errors)}
<form method="post" action="${esc(rc.url(`/children/${child.id}/register/${program.id}`))}" novalidate>
  <input type="hidden" name="waiver_version" value="${esc(waiver.id)}">
  <section class="panel"><fieldset class="field${groupError ? ' has-error' : ''}" id="group">
    <legend>Which group? <span class="req">(required)</span></legend>
    ${groupError ? `<span class="error">${esc(groupError.message)}</span>` : ''}
    ${options || '<p>No groups are scheduled yet.</p>'}
  </fieldset></section>
  ${waiverSection(waiver, values, errors)}
  <p class="hint">${paid ? `Signing up holds the place for ${HOLD_MINUTES} minutes while you pay. If you don't finish, the place goes back.`
    : 'This program is free: signing up confirms the place.'}</p>
  <button class="btn" type="submit">${paid ? 'Sign and continue to payment' : 'Sign and confirm'}</button>
</form>`;
  return page(rc, program.name, body, status);
}

/**
 * @returns {Promise<Response|null>} null if the path is not a programs route
 */
export async function programRoutes({ env, ctx, request, rc, session, pathname, method, readForm }) {
  if (pathname === '/programs' && method === 'GET') return catalogPage(env, rc, session);

  const m = /^\/children\/(\d{1,12})\/register\/([a-z0-9-]{1,40})$/.exec(pathname);
  if (!m) return null;
  if (!enrollmentEnabled(env)) {
    return page(rc, 'Sign-up paused', `<p><a href="${esc(rc.url('/programs'))}">&larr; All programs</a></p>
<h1>Sign-up is paused</h1><p class="lede">We've paused new sign-ups for a moment. Please try again later, or email info@tnsaints.com.</p>`, 503);
  }
  const child = await getChild(env, session.accountId, Number(m[1]));
  const program = await getProgram(env, m[2]);
  if (!child || !program || program.enrollment_mode !== 'self_serve') return notFoundResponse(rc);
  if (!programOpen(program)) {
    return page(rc, program.name, `<p><a href="${esc(rc.url('/programs'))}">&larr; All programs</a></p>
<h1>${esc(program.name)}</h1><p class="lede">Sign-up isn't open right now.</p>`);
  }
  const waiver = await currentWaiver(env, program);
  if (!waiver) {
    return page(rc, program.name, `<h1>${esc(program.name)}</h1>
<p class="lede">Sign-up is paused for a moment. Please try again later, or email info@tnsaints.com.</p>`, 503);
  }
  const [allGroups, existing, blockers] = await Promise.all([
    listGroups(env, program.id),
    liveEnrollment(env, session.accountId, child.id, program.id),
    applicationBlockers(env, session.accountId, child, program),
  ]);
  const groups = allGroups.filter((g) => g.status === 'active');
  const render = (extra = {}) => registerPage(rc, { child, program, groups, waiver, blockers, existing, ...extra });
  if (method === 'GET') return render();
  if (method !== 'POST') return null;
  if (existing || blockers.length) return render({ status: 409 });

  return readForm(async (form) => {
    if (String(form.get('waiver_version') || '') !== waiver.id) {
      return render({ status: 409, errors: [{ id: 'agree_risk', message: 'The waiver was updated while you were reading. Please read it again and sign.' }] });
    }
    const { values, errors } = validateApplication(form, groups);
    const group = groups.find((g) => String(g.id) === String(form.get('group') || ''));
    values.group = group ? String(group.id) : '';
    if (!group) errors.unshift({ id: 'group', message: 'Choose a group' });
    if (errors.length) return render({ values, errors, status: 400 });

    const signed = {
      playerId: child.id, program, groupId: group.id, waiver, signature: values.signature,
      relationship: values.relationship, photoRelease: values.photo_release === 'yes',
      ipHash: await hashIp(clientIp(request), env.IP_HASH_SALT),
    };
    const full = Number(group.taken) >= Number(group.capacity);
    const result = full ? { ok: false, reason: 'full' } : await register(env, session.accountId, signed);
    if (result.ok) {
      ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.register', subjectType: 'player',
        subjectId: child.id, detail: { program: program.id, group: group.id, waiver: waiver.id } }));
      return redirect(result.status === 'active' ? rc.url('/?notice=registered') : rc.url(`/pay/${result.ref}`));
    }
    if (result.reason === 'full' && program.waitlist_enabled && full) {
      const waited = await joinWaitlist(env, session.accountId, signed);
      if (waited.ok) {
        ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.waitlist', subjectType: 'player',
          subjectId: child.id, detail: { program: program.id, group: group.id } }));
        return redirect(rc.url('/?notice=waitlisted'));
      }
    }
    if (result.reason === 'full') {
      const fresh = (await listGroups(env, program.id)).filter((g) => g.status === 'active');
      return registerPage(rc, { child, program, groups: fresh, waiver, values, status: 409,
        notice: program.waitlist_enabled
          ? 'That group just filled. Choose another, or choose it again to join its waiting list.'
          : 'That group just filled. Please choose another.' });
    }
    if (result.reason === 'duplicate') return render({ existing: true, status: 409 });
    if (result.reason === 'paused') return redirect(rc.url('/programs'));
    return notFoundResponse(rc);
  });
}
