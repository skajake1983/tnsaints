/**
 * Families' deletion requests (privacy:manage): the queue, and moving a request
 * through its steps. Each step is allowed only from the steps before it
 * (privacy-ui.js NEXT_STATUS), checked inside the UPDATE.
 */

import { audit } from '../../auth/staff.js';
import { page, htmlResponse } from '../ui.js';
import { privacyBody, NEXT_STATUS as PRIVACY_NEXT } from '../privacy-ui.js';
import { NAV, denyHtml, seeOther } from '../nav.js';

const denyPrivacy = denyHtml('Privacy');

export const routes = [
  {
    method: 'GET', path: '/privacy', cap: 'privacy:manage', deny: denyPrivacy,
    handler: async ({ env, principal, url, base }) => {
      const { results } = await env.DB.prepare(
        `SELECT r.id, r.kind, r.subject_id, r.requested_by, r.status, r.created_at, h.display_name AS family_name
           FROM data_requests r LEFT JOIN households h ON CAST(h.id AS TEXT) = r.subject_id
          ORDER BY r.created_at DESC LIMIT 200`
      ).all();
      const msg = url.searchParams.get('msg') === 'updated' ? 'Updated.' : '';
      return htmlResponse(page({ title: 'Privacy', principal, nav: NAV, current: '/privacy',
        body: privacyBody({ rows: results || [], message: msg, base }) }));
    },
  },
  {
    method: 'POST', path: /^\/privacy\/(\d{1,12})\/(verified|scheduled|completed|rejected)$/, cap: 'privacy:manage',
    deny: denyPrivacy,
    handler: async ({ env, ctx, principal, base }, m) => {
      const target = m[2];
      const allowedFrom = Object.entries(PRIVACY_NEXT).filter(([, to]) => to.includes(target)).map(([from]) => from);
      const now = new Date().toISOString();
      const done = ['completed', 'rejected'].includes(target);
      const res = await env.DB.prepare(
        `UPDATE data_requests SET status = ?2, updated_at = ?3, completed_at = CASE WHEN ?4 THEN ?3 ELSE completed_at END,
                completed_by = CASE WHEN ?4 THEN ?5 ELSE completed_by END
          WHERE id = ?1 AND kind = 'deletion' AND status IN (SELECT value FROM json_each(?6))`
      ).bind(Number(m[1]), target, now, done ? 1 : 0, principal.email, JSON.stringify(allowedFrom)).run();
      if (res.meta.changes) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: `privacy.${target}`, subjectType: 'data_request',
          subjectId: m[1] }));
      }
      return seeOther(base, '/privacy?msg=updated');
    },
  },
];
