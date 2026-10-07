/**
 * Clearances (clearances:manage): background checks and trainings for adults
 * who work with children. See safety/clearances.js.
 */

import { audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { normEmail } from '../../auth/access.js';
import { page, htmlResponse } from '../ui.js';
import { clearancesBody, historyBody, CLEARANCE_STYLES } from '../clearances-ui.js';
import {
  clearanceBoard, validateClearance, recordClearance, revokeClearance, clearanceHistory,
} from '../../safety/clearances.js';
import { NAV, denyHtml, seeOther } from '../nav.js';

const denyClearances = denyHtml('Clearances', 'Clearances are limited to academy admins.');

function clearancePage(rc, body, status = 200) {
  return htmlResponse(page({ title: 'Clearances', principal: rc.principal, nav: NAV, current: '/clearances', body,
    extraStyles: CLEARANCE_STYLES }), { status });
}

export const routes = [
  {
    method: 'GET', path: '/clearances', cap: 'clearances:manage', deny: denyClearances,
    handler: async (rc) => clearancePage(rc, clearancesBody({ board: await clearanceBoard(rc.env),
      message: rc.url.searchParams.get('msg'), base: rc.base })),
  },
  {
    method: 'POST', path: '/clearances', cap: 'clearances:manage', deny: denyClearances,
    handler: async (rc) => {
      const { request, env, ctx, principal, base } = rc;
      let form;
      try { form = await readForm(request); } catch { form = null; }
      if (!form) return seeOther(base, '/clearances');
      const { value, errors } = validateClearance(form);
      if (Object.keys(errors).length) {
        return clearancePage(rc, clearancesBody({ board: await clearanceBoard(env), values: value, errors, base }), 400);
      }
      const id = await recordClearance(env, value, principal.email);
      // The kind and dates are not sensitive; the reference number is not copied here.
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'clearance.record', subjectType: 'clearance', subjectId: id,
        detail: { kind: value.kind, expires: value.expiresOn || null } }));
      return seeOther(base, '/clearances?msg=recorded');
    },
  },
  {
    method: 'GET', path: '/clearances/person', cap: 'clearances:manage', deny: denyClearances,
    handler: async (rc) => {
      const email = normEmail(String(rc.url.searchParams.get('email') || '')).slice(0, 254);
      const [records, board] = await Promise.all([clearanceHistory(rc.env, email), clearanceBoard(rc.env)]);
      const person = board.find((p) => p.email === email);
      return clearancePage(rc, historyBody({ email, name: person?.name, records, base: rc.base }));
    },
  },
  {
    method: 'POST', path: /^\/clearances\/(\d{1,12})\/revoke$/, cap: 'clearances:manage', deny: denyClearances,
    handler: async ({ env, ctx, principal, base }, m) => {
      const done = await revokeClearance(env, { id: Number(m[1]), actor: principal.email });
      if (done) ctx.waitUntil(audit(env, { actor: principal.email, action: 'clearance.revoke', subjectType: 'clearance', subjectId: m[1] }));
      return seeOther(base, `/clearances?msg=${done ? 'revoked' : 'not-found'}`);
    },
  },
];
