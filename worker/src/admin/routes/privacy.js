/**
 * Privacy (privacy:manage): families' deletion requests, moved through their
 * steps (each allowed only from the steps before it, checked inside the
 * UPDATE); the retention report; and legal holds.
 */

import { audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { page, htmlResponse } from '../ui.js';
import { privacyBody, NEXT_STATUS as PRIVACY_NEXT } from '../privacy-ui.js';
import { retentionConfig, retentionCounts, lastRetentionReport } from '../../privacy/retention.js';
import { listHolds, placeHold, releaseHold, HOLD_TYPES } from '../../privacy/holds.js';
import { NAV, denyHtml, seeOther } from '../nav.js';

const denyPrivacy = denyHtml('Privacy');

export const routes = [
  {
    method: 'GET', path: '/privacy', cap: 'privacy:manage', deny: denyPrivacy,
    handler: async ({ env, principal, url, base }) => {
      const [{ results }, report, holds] = await Promise.all([
        env.DB.prepare(
          `SELECT r.id, r.kind, r.subject_id, r.requested_by, r.status, r.created_at, h.display_name AS family_name
             FROM data_requests r LEFT JOIN households h ON CAST(h.id AS TEXT) = r.subject_id
            ORDER BY r.created_at DESC LIMIT 200`
        ).all(),
        lastRetentionReport(env),
        listHolds(env),
      ]);
      return htmlResponse(page({ title: 'Privacy', principal, nav: NAV, current: '/privacy',
        body: privacyBody({ rows: results || [], message: url.searchParams.get('msg'), base, report,
          config: retentionConfig(env), holds }) }));
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
  // Counts only, whatever the mode: removal happens in the daily job.
  {
    method: 'POST', path: '/privacy/retention/check', cap: 'privacy:manage', deny: denyPrivacy,
    handler: async ({ env, base }) => {
      const report = await retentionCounts(env);
      await env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('retention.report', ?1, 'staff', ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).bind(JSON.stringify({ ...report, removed: {} }), report.at).run();
      return seeOther(base, '/privacy?msg=report-run');
    },
  },
  {
    method: 'POST', path: '/privacy/holds', cap: 'privacy:manage', deny: denyPrivacy,
    handler: async ({ request, env, ctx, principal, base }) => {
      let form;
      try { form = await readForm(request); } catch { form = null; }
      const type = String(form?.get('subject_type') || '');
      const rawId = String(form?.get('subject_id') || '').trim();
      const subjectId = /^\d{1,12}$/.test(rawId) ? Number(rawId) : NaN;
      const { result, id } = HOLD_TYPES[type]
        ? await placeHold(env, { subjectType: type, subjectId, reason: form?.get('reason'), actor: principal.email })
        : { result: 'invalid' };
      if (result === 'placed') {
        // The reason is staff text: not copied into the audit log.
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'privacy.hold_placed', subjectType: type, subjectId,
          detail: { hold: id } }));
      }
      return seeOther(base, `/privacy?msg=hold-${result}`);
    },
  },
  {
    method: 'POST', path: /^\/privacy\/holds\/(\d{1,12})\/release$/, cap: 'privacy:manage', deny: denyPrivacy,
    handler: async ({ env, ctx, principal, base }, m) => {
      if (await releaseHold(env, { id: Number(m[1]), actor: principal.email })) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'privacy.hold_released', subjectType: 'legal_hold',
          subjectId: m[1] }));
        return seeOther(base, '/privacy?msg=hold-released');
      }
      return seeOther(base, '/privacy?msg=updated');
    },
  },
];
