/**
 * Privacy requests: families' downloads (recorded, already done) and deletion
 * requests (a person acts on them, by runbook).
 */

import { esc } from './ui.js';

export const NEXT_STATUS = {
  received: ['verified', 'rejected'],
  verified: ['scheduled', 'completed', 'rejected'],
  scheduled: ['completed', 'rejected'],
};

const LABEL = { verified: 'Mark verified', scheduled: 'Mark scheduled', completed: 'Mark completed', rejected: 'Reject' };

export function privacyBody({ rows, message, base = '' }) {
  const deletions = rows.filter((r) => r.kind === 'deletion');
  const exports = rows.filter((r) => r.kind === 'export');
  const list = deletions.length
    ? deletions
        .map((r) => `<div class="notice" style="border-left-color:${['received', 'verified', 'scheduled'].includes(r.status) ? 'var(--warn)' : 'var(--line)'}">
  <strong>Deletion request</strong> · family #${esc(r.subject_id)} · ${esc(r.family_name || '')} · asked ${esc(String(r.created_at).slice(0, 10))}
  by ${esc(r.requested_by)} · <strong>${esc(r.status)}</strong>
  <div style="margin-top:6px">${(NEXT_STATUS[r.status] || [])
    .map((s) => `<form method="post" action="${esc(base)}/privacy/${esc(r.id)}/${esc(s)}" style="display:inline"><button type="submit">${esc(LABEL[s])}</button></form>`)
    .join(' ')}</div></div>`)
        .join('')
    : '<div class="empty">No deletion requests.</div>';

  return `<h1>Privacy requests</h1>
<p class="sub">Families can download their data themselves; deletion requests need a person.</p>
${message ? `<div class="notice" role="status">${esc(message)}</div>` : ''}
<div class="panel"><h2>How to act on a deletion request</h2><div style="padding:12px 16px;font-size:14px">
<ol style="margin:0;padding-left:18px">
  <li>Verify: the request came from a signed-in guardian of that family (it did, if it is here), and reply by email to confirm.</li>
  <li>End any academy place and cancel their PayPal subscription if they have not.</li>
  <li>Delete the family's children, medical answers, contacts and accounts (PORTAL-SETUP.md, "Privacy requests").</li>
  <li>Keep signed waivers and payment records until their retention period ends.</li>
  <li>Mark completed, and email the family that it is done.</li>
</ol></div></div>
${list}
<div class="panel"><h2>Downloads (${exports.length})</h2><div style="padding:12px 16px;font-size:14px">${exports.length
    ? exports.slice(0, 50).map((r) => `<div>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))} · family #${esc(r.subject_id)} · ${esc(r.requested_by)}</div>`).join('')
    : 'None yet.'}</div></div>`;
}
