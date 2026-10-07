/**
 * Clearances: who may work with children, and what is lapsing.
 */

import { esc } from './ui.js';
import { CLEARANCE_KINDS } from '../safety/clearances.js';

export const CLEARANCE_STYLES = `
  .st { display:inline-block; font-size:12px; font-weight:700; padding:2px 8px; border-radius:99px; }
  .st.current { background:#e4f3ea; color:var(--ok); }
  .st.expiring { background:#fdf0dd; color:var(--warn); }
  .st.expired, .st.missing { background:#f6e5e5; color:var(--danger); }
  .cform { display:grid; gap:10px; padding:12px 16px; }
  .cform label { font-weight:600; font-size:14px; display:block; margin-bottom:3px; }
  .cform input, .cform select { font:inherit; font-size:14px; padding:6px 8px; min-height:36px; border:1px solid var(--line);
                                border-radius:6px; width:100%; box-sizing:border-box; }
  .cform .err { color:var(--danger); font-size:13px; }
  .cform .hint { color:var(--muted); font-size:12px; }
  .cform button, .revoke button { font:inherit; font-size:14px; padding:6px 12px; min-height:36px; border-radius:6px;
                                  border:1px solid var(--navy); background:var(--navy); color:#fff; cursor:pointer; }
  .revoke button { background:#fff; color:var(--danger); border-color:var(--danger); }
  @media (min-width: 760px) { .cform { grid-template-columns: 1fr 1fr; } .cform .wide { grid-column: 1 / -1; } }
`;

const STATUS_TEXT = { current: 'Current', expiring: 'Expiring soon', expired: 'Expired', missing: 'Missing' };
const MESSAGES = {
  recorded: 'Recorded.',
  revoked: 'Record withdrawn.',
  'not-found': 'That record was already withdrawn.',
};

function pill(status, record) {
  const when = record?.expires_on ? ` · ${record.expires_on}` : record ? ' · no expiry' : '';
  return `<span class="st ${esc(status)}">${esc(STATUS_TEXT[status])}</span><span class="sub" style="margin:0">${esc(when)}</span>`;
}

export function clearancesBody({ board, values = {}, errors = {}, message, base = '' }) {
  const v = (k) => esc(values[k] || '');
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}">${esc(errors[k])}</div>` : '');
  const aria = (k) => (errors[k] ? ` aria-invalid="true" aria-describedby="e-${k}"` : '');
  const attention = board.filter((p) => !p.cleared).length;
  return `<h1>Clearances</h1>
<p class="sub">Everyone who works with children needs a current background check, abuse-prevention training and concussion
training. A coach without all three cannot be put on a team. Enter the expiry date from the certificate.</p>
${message && MESSAGES[message] ? `<div class="notice" role="status">${esc(MESSAGES[message])}</div>` : ''}
${Object.keys(errors).length ? '<div class="notice" role="alert">Please fix the highlighted fields.</div>' : ''}
${attention ? `<div class="notice"><strong>${attention}</strong> ${attention === 1 ? 'person is' : 'people are'} not fully cleared.</div>` : ''}
<div class="panel"><div class="scroll"><table class="stack">
<thead><tr><th>Person</th>${Object.values(CLEARANCE_KINDS).map((l) => `<th>${esc(l)}</th>`).join('')}<th>Cleared</th></tr></thead>
<tbody>${board.map((p) => `<tr>
  <td data-label="Player"><a href="${esc(base)}/clearances/person?email=${encodeURIComponent(p.email)}">${esc(p.name || p.email)}</a>
    <div class="sub" style="margin:0">${esc(p.role)}</div></td>
  ${Object.keys(CLEARANCE_KINDS).map((k) => `<td data-label="${esc(CLEARANCE_KINDS[k])}">${pill(p.statuses[k], p.records[k])}</td>`).join('')}
  <td data-label="Cleared">${p.cleared ? 'Yes' : '<strong>No</strong>'}</td></tr>`).join('') || '<tr><td colspan="5">Nobody yet.</td></tr>'}</tbody>
</table></div></div>
<div class="panel"><h2>Record a clearance</h2>
<form class="cform" method="post" action="${esc(base)}/clearances" novalidate>
  <div><label for="pe">Their email (required)</label><input id="pe" name="person_email" type="email" maxlength="254" value="${v('email')}"${aria('person_email')}>${err('person_email')}</div>
  <div><label for="pn">Their name (required)</label><input id="pn" name="person_name" maxlength="80" value="${v('name')}"${aria('person_name')}>${err('person_name')}</div>
  <div><label for="ck">Clearance (required)</label><select id="ck" name="kind"${aria('kind')}>${Object.entries(CLEARANCE_KINDS)
    .map(([k, l]) => `<option value="${k}"${values.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${err('kind')}</div>
  <div><label for="cp">Provider</label><input id="cp" name="provider" maxlength="80" value="${v('provider')}"${aria('provider')}>${err('provider')}</div>
  <div><label for="cc">Completed on (required)</label><input id="cc" name="completed_on" type="date" value="${v('completedOn')}"${aria('completed_on')}>${err('completed_on')}</div>
  <div><label for="ce">Expires on</label><input id="ce" name="expires_on" type="date" value="${v('expiresOn')}"${aria('expires_on')}>
    <div class="hint">From the certificate. Blank only if it never expires.</div>${err('expires_on')}</div>
  <div class="wide"><label for="cr">Confirmation number</label><input id="cr" name="reference" maxlength="80" value="${v('reference')}"${aria('reference')}>
    <div class="hint">The provider's reference only — never upload or paste the report itself.</div>${err('reference')}</div>
  <div class="wide"><button type="submit">Record</button></div>
</form></div>`;
}

export function historyBody({ email, name, records, base = '' }) {
  return `<p><a href="${esc(base)}/clearances">&larr; All clearances</a></p>
<h1>${esc(name || email)}</h1><p class="sub">${esc(email)} · every record, newest first.</p>
<div class="panel"><div class="scroll"><table class="stack">
<thead><tr><th>Clearance</th><th>Completed</th><th>Expires</th><th>Provider</th><th>Reference</th><th>Recorded by</th><th></th></tr></thead>
<tbody>${records.map((r) => `<tr${r.revoked_at ? ' style="opacity:.6"' : ''}>
  <td data-label="Player">${esc(CLEARANCE_KINDS[r.kind] || r.kind)}${r.revoked_at ? ' (withdrawn)' : ''}</td>
  <td data-label="Completed">${esc(r.completed_on)}</td><td data-label="Expires">${esc(r.expires_on || 'No expiry')}</td>
  <td data-label="Provider">${esc(r.provider || '')}</td><td data-label="Reference">${esc(r.reference || '')}</td>
  <td data-label="Recorded by">${esc(r.recorded_by)} ${esc(String(r.recorded_at).slice(0, 10))}</td>
  <td data-label="Admin">${r.revoked_at ? '' : `<form class="revoke" method="post" action="${esc(base)}/clearances/${esc(r.id)}/revoke">
    <button type="submit">Withdraw</button></form>`}</td></tr>`).join('') || '<tr><td colspan="7">No records.</td></tr>'}</tbody>
</table></div></div>`;
}
