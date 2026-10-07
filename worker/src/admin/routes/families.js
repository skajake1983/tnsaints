/**
 * Portal families for staff: the roster projection (roster:view; contact
 * details by capability inside familiesView), inviting a family while the
 * portal is invite-only (crm:write), and one child's medical answer
 * (roster:medical, audited on every read and every refusal).
 */

import { can, audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { sendPortalInvite } from '../../email.js';
import { portalOrigin } from '../../auth/magic.js';
import { familiesView, shirtTotals, childMedical, invitedAccounts } from '../../programs/families.js';
import { page, htmlResponse } from '../ui.js';
import { familiesBody, medicalBody, FAMILY_STYLES } from '../families-ui.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

/** The portal's own address rule (auth/magic.js), so an invited address can always sign in. */
const PORTAL_EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

export const routes = [
  {
    method: 'GET', path: '/families', cap: 'roster:view',
    deny: denyHtml('Families', 'Families are limited to staff with roster access.'),
    handler: async ({ env, principal, url, base }) => {
      const view = await familiesView(env, principal);
      return htmlResponse(page({ title: 'Families', principal, nav: NAV, current: '/families',
        body: familiesBody({ ...view, totals: shirtTotals(view.families), base, message: url.searchParams.get('msg'),
          canInvite: can(principal, 'crm:write'), invited: await invitedAccounts(env) }), extraStyles: FAMILY_STYLES }));
    },
  },
  {
    method: 'POST', path: '/families/invite', cap: 'crm:write', deny: denyHtml('Families'),
    handler: async ({ request, env, ctx, principal, base }) => {
      const back = (msg) => seeOther(base, `/families?msg=${msg}`);
      let form;
      try { form = await readForm(request); } catch { form = null; }
      const typed = String(form?.get('email') || '').trim();
      const emailNorm = typed.toLowerCase();
      if (!PORTAL_EMAIL.test(emailNorm) || emailNorm.length > 254) return back('invalid');
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (email_norm) DO NOTHING`
      ).bind(typed, emailNorm, now).run();
      const account = await env.DB.prepare(`SELECT id, status FROM accounts WHERE email_norm = ?1`).bind(emailNorm).first();
      if (!account || account.status !== 'active') return back('invalid');
      const sent = await sendPortalInvite(env, { to: typed, url: `${portalOrigin(env)}/` });
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'portal.family_invite', subjectType: 'account', subjectId: account.id }));
      return back(sent.ok ? 'invited' : 'invited-no-email');
    },
  },
  {
    method: 'GET', path: /^\/families\/children\/(\d{1,12})\/medical$/, cap: 'roster:medical',
    // Audited even when refused, like the roster's reveal.
    deny: (rc, m) => {
      rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action: 'medical.denied', subjectType: 'player',
        subjectId: Number(m[1]), detail: { role: rc.principal.role } }));
      return denyHtml('Medical note', 'Medical notes are limited to academy admins.')(rc);
    },
    handler: async ({ env, ctx, principal, base }, m) => {
      const playerId = Number(m[1]);
      const child = await childMedical(env, playerId);
      if (!child) return notFoundPage(principal, 'No such child');
      // Which note, by whom; never what it said.
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'medical.read', subjectType: 'player',
        subjectId: playerId, detail: { source: 'portal', had_note: child.status === 'declared' } }));
      return htmlResponse(page({ title: 'Medical note', principal, nav: NAV, current: '/families',
        body: medicalBody({ child, base }), extraStyles: FAMILY_STYLES }));
    },
  },
];
