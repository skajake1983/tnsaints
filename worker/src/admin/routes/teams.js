/**
 * Teams (teams:view for coaches and admins; teams:manage for admins).
 *
 * A coach sees only the teams they are assigned to — any other team's page is
 * a 404, so a team they do not coach is not even confirmed to exist. Admins
 * see every team and its families, and assign coaches, schedule and replace
 * calendar links.
 */

import { can, audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { portalOrigin } from '../../auth/magic.js';
import { page, htmlResponse } from '../ui.js';
import { teamsListBody, teamBody, TEAM_STYLES } from '../teams-ui.js';
import {
  listTeams, teamDetail, coachesTeam, assignCoach, removeCoach, validateEvent, addEvent, cancelEvent, calendarToken,
  rotateCalendar,
} from '../../programs/teams.js';
import { clearanceBoard } from '../../safety/clearances.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

const denyTeams = denyHtml('Teams', 'Teams are for coaches and academy admins.');
const denyManage = denyHtml('Teams', 'Only academy admins change teams.');

async function renderTeam(rc, groupId, extra = {}, status = 200) {
  const { env, principal, base } = rc;
  const manage = can(principal, 'teams:manage');
  if (!manage && !(await coachesTeam(env, groupId, principal.email))) return notFoundPage(principal, 'No such team');
  const detail = await teamDetail(env, groupId);
  if (!detail) return notFoundPage(principal, 'No such team');
  const staffOptions = manage
    ? (await clearanceBoard(env)).filter((p) => p.role === 'coach' || p.role === 'admin')
      .map((p) => ({ email: p.email, name: p.name || p.email, cleared: p.cleared }))
    : [];
  const feedUrl = `${portalOrigin(env)}/calendar/${groupId}/${await calendarToken(env, detail.team)}.ics`;
  return htmlResponse(page({ title: detail.team.name, principal, nav: NAV, current: '/teams', extraStyles: TEAM_STYLES,
    body: teamBody({ detail, base, canManage: manage, canSeeFamilies: can(principal, 'roster:contact'), staffOptions, feedUrl,
      message: rc.url.searchParams.get('msg'), ...extra }) }), { status });
}

async function formOf(request) {
  try { return await readForm(request); } catch { return null; }
}

export const routes = [
  {
    method: 'GET', path: '/teams', cap: 'teams:view', deny: denyTeams,
    handler: async ({ env, principal, base }) => {
      const manage = can(principal, 'teams:manage');
      const teams = await listTeams(env, { coachEmail: manage ? null : principal.email });
      return htmlResponse(page({ title: 'Teams', principal, nav: NAV, current: '/teams', extraStyles: TEAM_STYLES,
        body: teamsListBody({ teams, base, canManage: manage }) }));
    },
  },
  {
    method: 'GET', path: /^\/teams\/(\d{1,12})$/, cap: 'teams:view', deny: denyTeams,
    handler: (rc, m) => renderTeam(rc, Number(m[1])),
  },
  {
    method: 'POST', path: /^\/teams\/(\d{1,12})\/coaches(\/remove)?$/, cap: 'teams:manage', deny: denyManage,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const groupId = Number(m[1]);
      const form = await formOf(request);
      const email = String(form?.get('email') || '');
      let result;
      if (m[2]) {
        result = (await removeCoach(env, { groupId, email, actor: principal.email })) ? 'removed' : 'invalid';
      } else {
        result = await assignCoach(env, { groupId, email, role: String(form?.get('role') || ''), actor: principal.email });
      }
      if (result === 'assigned' || result === 'removed') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: `team.coach_${result}`, subjectType: 'team', subjectId: groupId,
          detail: { coach: email.toLowerCase() } }));
      }
      return seeOther(base, `/teams/${groupId}?msg=${result}`);
    },
  },
  {
    method: 'POST', path: /^\/teams\/(\d{1,12})\/events$/, cap: 'teams:manage', deny: denyManage,
    handler: async (rc, m) => {
      const groupId = Number(m[1]);
      const form = await formOf(rc.request);
      if (!form) return seeOther(rc.base, `/teams/${groupId}?msg=invalid`);
      const { value, errors } = validateEvent(form);
      if (Object.keys(errors).length) {
        const eventValues = { ...value, starts_local: String(form.get('starts_at') || ''), ends_local: String(form.get('ends_at') || '') };
        return renderTeam(rc, groupId, { eventValues, eventErrors: errors }, 400);
      }
      const id = await addEvent(rc.env, groupId, value, rc.principal.email);
      if (!id) return notFoundPage(rc.principal, 'No such team');
      rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'team.event_add', subjectType: 'team', subjectId: groupId,
        detail: { event: id, kind: value.kind } }));
      return seeOther(rc.base, `/teams/${groupId}?msg=event-added`);
    },
  },
  {
    method: 'POST', path: /^\/teams\/(\d{1,12})\/events\/(\d{1,12})\/cancel$/, cap: 'teams:manage', deny: denyManage,
    handler: async ({ env, ctx, principal, base }, m) => {
      const done = await cancelEvent(env, { groupId: Number(m[1]), id: Number(m[2]) });
      if (done) ctx.waitUntil(audit(env, { actor: principal.email, action: 'team.event_cancel', subjectType: 'team', subjectId: m[1],
        detail: { event: Number(m[2]) } }));
      return seeOther(base, `/teams/${m[1]}?msg=${done ? 'event-cancelled' : 'invalid'}`);
    },
  },
  {
    method: 'POST', path: /^\/teams\/(\d{1,12})\/calendar\/rotate$/, cap: 'teams:manage', deny: denyManage,
    handler: async ({ env, ctx, principal, base }, m) => {
      const done = await rotateCalendar(env, Number(m[1]));
      if (done) ctx.waitUntil(audit(env, { actor: principal.email, action: 'team.calendar_rotate', subjectType: 'team', subjectId: m[1] }));
      return seeOther(base, `/teams/${m[1]}?msg=${done ? 'rotated' : 'invalid'}`);
    },
  },
];

