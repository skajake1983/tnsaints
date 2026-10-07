/**
 * Enrollment requests (enrollments:manage) and program settings -- price,
 * groups, waiver versions, open/close (events:manage).
 *
 * The queue is where applications become seats. Plain forms,
 * post-redirect-get; see admin/enrollments-ui.js and admin/programs-ui.js.
 */

import { audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { sendEnrollmentOffer } from '../../email.js';
import { portalOrigin } from '../../auth/magic.js';
import {
  getProgram, listGroups, queue as enrollmentQueue, offerSeat, waitlist as waitlistEnrollment,
  decline as declineEnrollment, expireOffers, householdEmails, enrollmentWithGroup, priceLine, enrollmentEnabled,
} from '../../programs/enrollment.js';
import {
  listWaivers, saveProgramSettings, setProgramStatus, createGroup, updateGroup, createWaiver,
} from '../../programs/settings.js';
import { page, htmlResponse } from '../ui.js';
import { enrollmentsBody, ENROLLMENT_STYLES, DECLINE_REASONS } from '../enrollments-ui.js';
import { programBody, PROGRAM_STYLES } from '../programs-ui.js';
import { programsListBody } from '../programs-list-ui.js';
import { listPrograms, createProgram, saveProgramDetails } from '../../programs/manage.js';
import { setCurrentEvaluation } from '../../programs/evaluation.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

/** The academy is the one approval-mode program in Phase 1. */
export const ENROLLMENT_PROGRAM = 'academy';

const denyEnrollments = denyHtml('Enrollments', 'Only academy admins can offer seats.');
const denyPrograms = denyHtml('Programs', 'Only academy admins can change program settings.');

export const routes = [
  {
    method: 'GET', path: '/programs', cap: 'events:manage', deny: denyPrograms,
    handler: async ({ env, principal, base }) => htmlResponse(page({ title: 'Programs', principal, nav: NAV, current: '/programs',
      body: programsListBody({ programs: await listPrograms(env), base }), extraStyles: PROGRAM_STYLES })),
  },
  {
    method: 'POST', path: '/programs/new', cap: 'events:manage', deny: denyPrograms,
    handler: async ({ request, env, ctx, principal, base }) => {
      let form;
      try { form = await readForm(request); } catch { form = null; }
      if (!form) return seeOther(base, '/programs');
      const { result, id, errors } = await createProgram(env, form);
      if (result === 'created') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'program.create', subjectType: 'program', subjectId: id }));
        return seeOther(base, `/programs/${id}?msg=created`);
      }
      const values = { id: String(form.get('id') || ''), name: String(form.get('name') || ''), kind: String(form.get('kind') || ''),
        billing: String(form.get('billing') || '') };
      return htmlResponse(page({ title: 'Programs', principal, nav: NAV, current: '/programs',
        body: programsListBody({ programs: await listPrograms(env), base, values, errors }), extraStyles: PROGRAM_STYLES }), { status: 400 });
    },
  },
  {
    method: 'GET', path: '/enrollments', cap: 'enrollments:manage', deny: denyEnrollments,
    handler: ({ env, principal, url, base }) => renderEnrollments(env, principal, url, base),
  },
  {
    method: 'POST', path: /^\/enrollments\/(\d{1,12})\/(offer|waitlist|decline)$/, cap: 'enrollments:manage',
    deny: denyEnrollments,
    handler: ({ request, env, ctx, principal, base }, m) =>
      handleEnrollmentAction(request, env, ctx, principal, Number(m[1]), m[2], base),
  },
  {
    method: 'GET', path: /^\/programs\/([a-z0-9-]{1,40})$/, cap: 'events:manage', deny: denyPrograms,
    handler: async ({ env, principal, url, base }, m) => {
      const program = await getProgram(env, m[1]);
      if (!program) return notFoundPage(principal, 'No such program');
      return renderProgram(env, principal, program, url, base);
    },
  },
  {
    method: 'POST', path: /^\/programs\/([a-z0-9-]{1,40})\/(settings|status|groups|waivers|details|current)(?:\/(\d{1,12}))?$/,
    cap: 'events:manage', deny: denyPrograms,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const program = await getProgram(env, m[1]);
      if (!program) return notFoundPage(principal, 'No such program');
      return handleProgramPost(request, env, ctx, principal, program, m[2], m[3], base);
    },
  },
];

async function renderEnrollments(env, principal, url, base) {
  const wanted = String(url.searchParams.get('program') || ENROLLMENT_PROGRAM);
  const program = (/^[a-z0-9-]{1,40}$/.test(wanted) && await getProgram(env, wanted)) || await getProgram(env, ENROLLMENT_PROGRAM);
  if (!program) {
    return htmlResponse(page({ title: 'Enrollments', principal, nav: NAV, current: '/enrollments',
      body: '<h1>Enrollment requests</h1><p class="sub">The academy program has not been set up.</p>' }));
  }
  // Keep statuses honest on view: lapsed offers go back to the waiting list.
  // Their seats were already free — a lapsed offer stops counting at once.
  await expireOffers(env);
  const [groups, rows] = await Promise.all([listGroups(env, program.id), enrollmentQueue(env, program.id)]);
  return htmlResponse(
    page({
      title: 'Enrollments',
      principal,
      nav: NAV,
      current: '/enrollments',
      body: enrollmentsBody({
        program, groups, rows, message: url.searchParams.get('msg'), base, paused: !enrollmentEnabled(env),
        programs: (await listPrograms(env)).filter((p) => p.kind !== 'evaluation'),
      }),
      extraStyles: ENROLLMENT_STYLES,
    })
  );
}

async function handleEnrollmentAction(request, env, ctx, principal, enrollmentId, action, base) {
  let back = (msg) => seeOther(base, `/enrollments?msg=${msg}`);
  let form;
  try {
    form = await readForm(request);
  } catch {
    form = null;
  }
  if (!form) return back('state');

  const enrollment = await env.DB.prepare(`SELECT id, program_id FROM enrollments WHERE id = ?1`)
    .bind(enrollmentId)
    .first();
  if (!enrollment) return back('state');
  if (enrollment.program_id !== ENROLLMENT_PROGRAM) {
    back = (msg) => seeOther(base, `/enrollments?program=${enrollment.program_id}&msg=${msg}`);
  }
  const log = (act, detail) =>
    ctx.waitUntil(audit(env, { actor: principal.email, action: act, subjectType: 'enrollment', subjectId: enrollmentId, detail }));

  if (action === 'offer') {
    const groupId = Number(form.get('group_id'));
    const program = await getProgram(env, enrollment.program_id);
    if (!Number.isInteger(groupId) || !program) return back('state');
    const result = await offerSeat(env, {
      enrollmentId, groupId, staffEmail: principal.email, holdDays: Number(program.offer_hold_days) || 7,
    });
    if (!result.ok) return back(result.reason);
    log('enrollment.offer', { group: groupId });
    const e = await enrollmentWithGroup(env, enrollmentId);
    const sent = await sendEnrollmentOffer(env, {
      to: await householdEmails(env, enrollmentId),
      programName: e.program_name,
      groupName: e.group_name,
      schedule: e.schedule_summary,
      location: e.location || '',
      startsOn: e.starts_on || '',
      priceLine: priceLine(program),
      payBy: formatPayBy(result.expiresAt),
      url: `${portalOrigin(env)}/`,
    });
    return back(sent.ok ? 'offered' : 'offered-no-email');
  }

  if (action === 'waitlist') {
    if (!(await waitlistEnrollment(env, { enrollmentId, staffEmail: principal.email }))) return back('state');
    log('enrollment.waitlist');
    return back('waitlisted');
  }

  if (action === 'decline') {
    const reason = String(form.get('reason') || '');
    if (!DECLINE_REASONS.some(([v]) => v === reason)) return back('state');
    if (!(await declineEnrollment(env, { enrollmentId, staffEmail: principal.email, reason }))) return back('state');
    log('enrollment.decline', { reason });
    return back('declined');
  }

  return back('state');
}

/** "Saturday, October 3" in Central time, for the pay-by line of the offer email. */
function formatPayBy(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(isoString));
}

async function renderProgram(env, principal, program, url, base) {
  const [groups, waivers, current] = await Promise.all([
    listGroups(env, program.id), listWaivers(env),
    env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'evaluation.current'`).first(),
  ]);
  return htmlResponse(
    page({
      title: program.name,
      principal,
      nav: NAV,
      current: '/enrollments',
      body: programBody({ program, groups, waivers, message: url.searchParams.get('msg'), base,
        evaluationCurrent: current?.value === program.id }),
      extraStyles: PROGRAM_STYLES,
    })
  );
}

async function handleProgramPost(request, env, ctx, principal, program, section, groupId, base) {
  const back = (msg) => seeOther(base, `/programs/${program.id}?msg=${msg}`);
  let form;
  try {
    form = await readForm(request, 32 * 1024);
  } catch {
    form = null;
  }
  if (!form) return back('invalid');
  const log = (action, subjectType, subjectId, detail) =>
    ctx.waitUntil(audit(env, { actor: principal.email, action, subjectType, subjectId, detail }));

  if (section === 'settings' && !groupId) {
    const result = await saveProgramSettings(env, program.id, form);
    if (result === 'saved') log('program.update', 'program', program.id);
    return back(result);
  }
  if (section === 'status' && !groupId) {
    const result = await setProgramStatus(env, program.id, String(form.get('status') || ''));
    if (result === 'opened' || result === 'closed') log(`program.${result === 'opened' ? 'open' : 'close'}`, 'program', program.id);
    return back(result);
  }
  if (section === 'groups' && !groupId) {
    const { result, id } = await createGroup(env, program.id, form);
    if (id) log('group.create', 'group', id, { program: program.id });
    return back(result);
  }
  if (section === 'groups' && groupId) {
    const result = await updateGroup(env, program.id, Number(groupId), form);
    if (result === 'group-saved') log('group.update', 'group', groupId, { program: program.id });
    return back(result);
  }
  if (section === 'current' && !groupId) {
    const result = await setCurrentEvaluation(env, form.get('current') === 'on' ? program.id : null, principal.email);
    if (result !== 'invalid') log(`evaluation.${result}`, 'program', program.id);
    return back(result);
  }
  if (section === 'details' && !groupId) {
    const result = await saveProgramDetails(env, program, form);
    if (result === 'details-saved') log('program.details', 'program', program.id);
    return back(result);
  }
  if (section === 'waivers' && !groupId) {
    const { result, id } = await createWaiver(env, program.id, form);
    if (id) log('waiver.create', 'waiver', id);
    return back(result);
  }
  return back('invalid');
}
