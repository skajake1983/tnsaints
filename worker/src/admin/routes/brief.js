/**
 * The daily staff brief: preview what it would say now, and send it now
 * (events:manage).
 */

import { audit } from '../../auth/staff.js';
import { briefSummary, briefLines, runStaffBrief } from '../../jobs/brief.js';
import { sendStaffBriefEmail } from '../../email.js';
import { page, esc, htmlResponse } from '../ui.js';
import { NAV, denyHtml, seeOther } from '../nav.js';

const denyBrief = denyHtml('Brief');
const MESSAGES = {
  sent: 'Sent.',
  empty: 'Nothing to send.',
  budget: "Not sent: today's email allowance is used up.",
  error: 'Not sent: the email provider failed.',
};

export const routes = [
  {
    method: 'GET', path: '/brief', cap: 'events:manage', deny: denyBrief,
    handler: async ({ env, principal, url, base }) => {
      const lines = briefLines(await briefSummary(env));
      const msg = MESSAGES[url.searchParams.get('msg')] || '';
      const body = `<h1>Today's brief</h1><p class="sub">What the daily staff email would say right now. It is sent once a day, only when there is something here${
        env.STAFF_BRIEF_ENABLED === 'true' ? '' : ' (the daily send is switched off: STAFF_BRIEF_ENABLED)'}.</p>
${msg ? `<div class="notice" role="status">${esc(msg)}</div>` : ''}
${lines.length ? `<div class="panel"><ul style="margin:0;padding:14px 32px">${lines.map((l) => `<li><a href="${esc(base + l.path)}">${esc(l.text)}</a></li>`).join('')}</ul></div>
<form method="post" action="${esc(base)}/brief/send"><button class="bigbtn" type="submit">Send it now</button></form>` : '<div class="empty">Nothing to report today.</div>'}`;
      return htmlResponse(page({ title: 'Brief', principal, nav: NAV, current: '/brief', body }));
    },
  },
  {
    method: 'POST', path: '/brief/send', cap: 'events:manage', deny: denyBrief,
    handler: async ({ env, ctx, principal, base }) => {
      const result = await runStaffBrief(env, sendStaffBriefEmail, { force: true });
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'brief.send', detail: { result: result.reason } }));
      return seeOther(base, `/brief?msg=${result.reason}`);
    },
  },
];
