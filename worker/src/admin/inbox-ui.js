/**
 * The Inbox: website inquiries as they arrive, before the full CRM screens
 * exist. Read-only apart from "mark handled". One-to-one replies go out from
 * Outlook (the email link opens it), never through the site's email budget.
 */

import { esc } from './ui.js';

const PURPOSE = {
  general: 'General', player: 'Academy interest', coaching: 'Coaching', sponsor: 'Sponsorship', volunteer: 'Volunteer',
};

export const INBOX_STYLES = `
  .inq { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:10px; font-size:14px; }
  .inq.handled { opacity: .7; }
  .inq h2 { font-size:15px; margin:0 0 4px; }
  .inq .meta { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
  .inq .msg { white-space: pre-wrap; margin: 6px 0; }
  .inq form { margin: 6px 0 0; }
  .filters a { margin-right: 12px; font-weight: 700; }
`;

const when = (value) =>
  new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function detailLine(purpose, fields) {
  if (purpose === 'player') {
    return [fields.player_name, fields.grade, fields.school, fields.position].filter(Boolean).join(' · ');
  }
  if (purpose === 'coaching') return [fields.role, fields.location].filter(Boolean).join(' · ');
  if (purpose === 'sponsor') return fields.organization || '';
  return '';
}

export function inboxBody({ rows, status, canWrite, base = '' }) {
  const list = rows.length
    ? rows
        .map((r) => {
          let fields = {};
          try { fields = JSON.parse(r.fields || '{}'); } catch { fields = {}; }
          const detail = detailLine(r.purpose, fields);
          return `<div class="inq${r.status === 'handled' ? ' handled' : ''}">
  <h2>${esc(PURPOSE[r.purpose] || r.purpose)}: ${esc(r.name || 'Unknown')}</h2>
  <div class="meta">${esc(when(r.received_at))}${r.email ? ` · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}${
    r.phone ? ` · ${esc(r.phone)}` : ''}${r.status === 'handled' ? ' · handled' : ''}${r.household_id ? ' · has a portal family' : ''}</div>
  ${detail ? `<div>${esc(detail)}</div>` : ''}
  ${fields.highlight_link ? `<div><a href="${esc(fields.highlight_link)}" rel="noopener noreferrer" target="_blank">Highlights</a></div>` : ''}
  ${r.message ? `<div class="msg">${esc(r.message)}</div>` : ''}
  ${canWrite && r.status !== 'handled'
    ? `<form method="post" action="${esc(base)}/inbox/${esc(r.id)}/handled"><button type="submit">Mark handled</button></form>` : ''}
</div>`;
        })
        .join('')
    : `<div class="empty">No ${status === 'handled' ? 'handled' : 'new'} inquiries.</div>`;

  return `<h1>Inbox</h1>
<p class="sub">Messages from the website's forms. Reply from Outlook; mark each one handled when it is.</p>
<p class="filters"><a href="${esc(base)}/inbox"${status !== 'handled' ? ' aria-current="page"' : ''}>New</a>
<a href="${esc(base)}/inbox?status=handled"${status === 'handled' ? ' aria-current="page"' : ''}>Handled</a></p>
${list}`;
}
