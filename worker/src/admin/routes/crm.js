/**
 * The CRM screens. So far: the Inbox of website inquiries (crm:view to read,
 * crm:write to mark one handled).
 */

import { can, audit } from '../../auth/staff.js';
import { page, htmlResponse } from '../ui.js';
import { inboxBody, INBOX_STYLES } from '../inbox-ui.js';
import { NAV, denyHtml, seeOther } from '../nav.js';

export const routes = [
  {
    method: 'GET', path: '/inbox', cap: 'crm:view',
    deny: denyHtml('Inbox', 'The inbox is limited to academy admins.'),
    handler: async ({ env, principal, url, base }) => {
      const status = url.searchParams.get('status') === 'handled' ? 'handled' : 'new';
      const { results } = await env.DB.prepare(
        `SELECT i.id, i.purpose, i.fields, i.message, i.received_at, i.status,
                c.name, c.email, c.phone, c.household_id
           FROM crm_inquiries i LEFT JOIN crm_contacts c ON c.id = i.contact_id
          WHERE i.status = ?1 ORDER BY i.received_at DESC LIMIT 100`
      ).bind(status).all();
      return htmlResponse(page({ title: 'Inbox', principal, nav: NAV, current: '/inbox',
        body: inboxBody({ rows: results || [], status, canWrite: can(principal, 'crm:write'), base }),
        extraStyles: INBOX_STYLES }));
    },
  },
  {
    method: 'POST', path: /^\/inbox\/(\d{1,12})\/handled$/, cap: 'crm:write', deny: denyHtml('Inbox'),
    handler: async ({ env, ctx, principal, base }, m) => {
      const now = new Date().toISOString();
      const res = await env.DB.prepare(
        `UPDATE crm_inquiries SET status = 'handled', handled_by = ?2, handled_at = ?3 WHERE id = ?1 AND status = 'new'`
      ).bind(Number(m[1]), principal.email, now).run();
      if (res.meta.changes) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.inquiry_handled', subjectType: 'inquiry',
          subjectId: m[1] }));
      }
      return seeOther(base, '/inbox');
    },
  },
];
