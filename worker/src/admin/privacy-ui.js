/**
 * Privacy: families' downloads (recorded, already done), deletion requests
 * (automatic after the grace period, privacy/deletion.js; older ones moved by
 * hand), the retention report, and legal holds.
 */

import { esc } from './ui.js';
import { HOLD_TYPES } from '../privacy/holds.js';

export const NEXT_STATUS = {
  received: ['verified', 'rejected'],
  verified: ['scheduled', 'completed', 'rejected'],
  scheduled: ['completed', 'rejected'],
};

const LABEL = { verified: 'Mark verified', scheduled: 'Mark scheduled', completed: 'Mark completed', rejected: 'Reject' };

// An automatic request runs itself: marking it completed by hand would skip
// the deletion, so only Reject is offered (and the route refuses the rest).
const nextFor = (r) => (r.purge_after ? (r.status === 'scheduled' ? ['rejected'] : []) : NEXT_STATUS[r.status] || []);

const BLOCKED = {
  'stripe-not-configured': "it has a Stripe subscription and Stripe isn't set up here",
  'stripe-other-environment': 'its Stripe subscription is in the other Stripe mode (test or live)',
  'stripe-cancel-failed': "Stripe wouldn't cancel its subscription; it tries again each hour",
};

const COUNT_LABELS = [
  ['accounts', 'sign-ins'], ['children', 'children'], ['places', 'places ended'], ['medical', 'medical answers'],
  ['emergencyContacts', 'emergency contacts'], ['registrations', 'evaluation registrations'], ['crmContacts', 'CRM contacts'],
  ['stripeCancelled', 'Stripe subscriptions cancelled'],
];

function parseCounts(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function deletionState(r) {
  const c = parseCounts(r.result_counts);
  const day = (iso) => String(iso).slice(0, 16).replace('T', ' ');
  if (r.status === 'scheduled' && r.purge_after) {
    if (Number(r.held)) return `<strong>On legal hold</strong> — will not run until the hold is released (due ${esc(day(r.purge_after))} UTC).`;
    if (c?.blocked) return `<strong>Waiting:</strong> ${esc(BLOCKED[c.blocked] || c.blocked)}.`;
    return `Deletes automatically after ${esc(day(r.purge_after))} UTC, unless the family cancels or you place a legal hold on family #${esc(r.subject_id)}.`;
  }
  if (r.status === 'completed' && c) {
    const parts = COUNT_LABELS.filter(([k]) => c[k]).map(([k, l]) => `${esc(c[k])} ${l}`);
    return `Deleted: ${parts.join(', ') || 'nothing but the request'}.${c.emailed ? ' The family was emailed.' : ''}`;
  }
  return '';
}

function paypalPanel(rows, base) {
  if (!rows.length) return '';
  return `<div class="panel"><h2>PayPal to cancel for deleted families (${rows.length})</h2><div style="padding:12px 16px;font-size:14px">
<p class="sub" style="margin:0 0 8px">These families deleted their data. Their old Join-page PayPal subscriptions can't be cancelled from here:
cancel each in PayPal, then mark it.</p>
${rows.map((p) => `<div style="margin-bottom:6px"><code>${esc(p.outside_reference)}</code> · family #${esc(p.household_id)}
  <form method="post" action="${esc(base)}/privacy/paypal/${esc(p.id)}/cancelled" style="display:inline"><button type="submit">Cancelled in PayPal</button></form></div>`).join('')}
</div></div>`;
}

export const PRIVACY_MESSAGES = {
  updated: 'Updated.',
  'hold-placed': 'Legal hold placed. Retention will not touch it until it is released.',
  'hold-exists': 'That record already has an active hold.',
  'hold-not-found': 'There is no such record. Use the number from its page address.',
  'hold-invalid': 'Choose what to hold, give its number and a short reason (3 to 200 characters).',
  'hold-released': 'Hold released.',
  'report-run': 'Retention report updated. Nothing was removed.',
  'paypal-cancelled': 'Marked as cancelled in PayPal.',
};

const SUBJECT_LINK = {
  household: (id) => `/crm/families/${id}`,
  crm_contact: (id) => `/crm/contacts/${id}`,
};

function retentionPanel({ report, config, base }) {
  const mode = config.mode === 'enforce'
    ? '<strong>Enforcing.</strong> The daily job removes what each rule finds, a batch at a time.'
    : '<strong>Report only.</strong> Nothing is removed. Switch RETENTION_MODE to "enforce" once the periods are approved (plan item O15).';
  const rows = report
    ? report.rules.map((r) => `<tr><td data-label="Rule">${esc(r.label)}</td><td data-label="Due">${esc(r.due)}</td>
        <td data-label="Kept by a hold">${esc(r.held)}</td>${report.removed && report.removed[r.key] !== undefined
        ? `<td data-label="Removed">${esc(report.removed[r.key])}</td>` : '<td data-label="Removed">—</td>'}</tr>`).join('')
    : '';
  return `<div class="panel"><h2>Retention</h2><div style="padding:12px 16px;font-size:14px">
<p style="margin:0 0 8px">${mode} Periods (defaults pending the attorney): medical answers ${esc(config.medicalDays)} days after the last place or evaluation;
contacts never converted ${esc(config.leadMonths)} months; waivers ${esc(config.waiverYears)} years and age ${esc(config.waiverMinAge)}; payments ${esc(config.paymentYears)} years.</p>
${report ? `<p class="sub" style="margin:0 0 8px">Last checked ${esc(String(report.at).slice(0, 16).replace('T', ' '))} UTC.${
    report.waiversAgeUnknown ? ` ${esc(report.waiversAgeUnknown)} old waiver(s) kept because the child's date of birth is unknown.` : ''}</p>
<div class="scroll"><table class="stack"><thead><tr><th>Rule</th><th>Due now</th><th>Kept by a hold</th><th>Removed last run</th></tr></thead>
<tbody>${rows}</tbody></table></div>` : '<p class="sub" style="margin:0">Not checked yet: the daily job has not run.</p>'}
<form method="post" action="${esc(base)}/privacy/retention/check" style="margin-top:10px"><button type="submit">Check now (counts only)</button></form>
</div></div>`;
}

function holdsPanel({ holds, base }) {
  const active = holds.filter((h) => !h.released_at);
  const released = holds.filter((h) => h.released_at);
  const line = (h) => {
    const link = SUBJECT_LINK[h.subject_type];
    const name = `${HOLD_TYPES[h.subject_type] || h.subject_type} #${h.subject_id}${h.subject_name ? ` (${h.subject_name})` : ''}`;
    return `${link ? `<a href="${esc(base + link(h.subject_id))}">${esc(name)}</a>` : esc(name)} · ${esc(h.reason)} · placed ${esc(String(h.placed_at).slice(0, 10))} by ${esc(h.placed_by)}`;
  };
  return `<div class="panel"><h2>Legal holds (${active.length} active)</h2><div style="padding:12px 16px;font-size:14px">
<p class="sub" style="margin:0 0 8px">A hold keeps everything about a family, child, contact or evaluation registration out of retention — for a dispute,
an insurance claim or a safeguarding concern. Keep the reason short; never medical or safeguarding detail.</p>
${active.length ? active.map((h) => `<div style="margin-bottom:6px">${line(h)}
  <form method="post" action="${esc(base)}/privacy/holds/${esc(h.id)}/release" style="display:inline"><button type="submit">Release</button></form></div>`).join('')
    : '<p style="margin:0 0 8px">No active holds.</p>'}
<form method="post" action="${esc(base)}/privacy/holds" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
  <div><label for="ht" style="display:block;font-size:12px;font-weight:700">What</label>
    <select id="ht" name="subject_type">${Object.entries(HOLD_TYPES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
  <div><label for="hi" style="display:block;font-size:12px;font-weight:700">Number</label>
    <input id="hi" name="subject_id" inputmode="numeric" pattern="[0-9]{1,12}" required size="8" aria-describedby="hih"></div>
  <div style="flex:1 1 220px"><label for="hr" style="display:block;font-size:12px;font-weight:700">Reason</label>
    <input id="hr" name="reason" maxlength="200" minlength="3" required style="width:100%;box-sizing:border-box"></div>
  <div><button type="submit">Place hold</button></div>
</form>
<p id="hih" class="sub" style="margin:4px 0 0">The number is in the record's page address, e.g. /crm/families/<strong>12</strong>.</p>
${released.length ? `<details style="margin-top:8px"><summary>Released (${released.length})</summary>${released
    .map((h) => `<div>${line(h)} · released ${esc(String(h.released_at).slice(0, 10))} by ${esc(h.released_by)}</div>`).join('')}</details>` : ''}
</div></div>`;
}

export function privacyBody({ rows, message, base = '', report = null, config, holds = [], paypal = [] }) {
  const deletions = rows.filter((r) => r.kind === 'deletion');
  const exports = rows.filter((r) => r.kind === 'export');
  const text = PRIVACY_MESSAGES[message] || '';
  const list = deletions.length
    ? deletions
        .map((r) => `<div class="notice" style="border-left-color:${['received', 'verified', 'scheduled'].includes(r.status) ? 'var(--warn)' : 'var(--line)'}">
  <strong>Deletion request</strong> · family #${esc(r.subject_id)} · ${esc(r.family_name || '')} · asked ${esc(String(r.created_at).slice(0, 10))}
  by ${esc(r.requested_by)} · <strong>${esc(r.status)}</strong>
  ${deletionState(r) ? `<div style="margin-top:4px">${deletionState(r)}</div>` : ''}
  <div style="margin-top:6px">${nextFor(r)
    .map((s) => `<form method="post" action="${esc(base)}/privacy/${esc(r.id)}/${esc(s)}" style="display:inline"><button type="submit">${esc(LABEL[s])}</button></form>`)
    .join(' ')}</div></div>`)
        .join('')
    : '<div class="empty">No deletion requests.</div>';

  return `<h1>Privacy requests</h1>
<p class="sub">Families download and delete their own data. A deletion runs by itself 7 days after the family's main guardian asks.</p>
${text ? `<div class="notice" role="status">${esc(text)}</div>` : ''}
<div class="panel"><h2>How deletion works</h2><div style="padding:12px 16px;font-size:14px">
<ol style="margin:0;padding-left:18px">
  <li>The guardian who set up the family asks on their Account page, with a recent sign-in. They're emailed the date, and every guardian sees it.</li>
  <li>Until then they can cancel. <strong>To stop it yourself</strong> (a dispute, an insurance claim, a safeguarding concern), place a legal hold on the family below.</li>
  <li>Then the hourly job ends their places, cancels Stripe billing, and deletes sign-ins, children's details, medical answers, contacts, CRM
  details and evaluation details. Signed waivers and payment records stay, with the child's name and date of birth, until retention removes them.</li>
  <li>The family is emailed when it's done. Cancel any old PayPal subscription it had (listed below) by hand.</li>
</ol></div></div>
${list}
${paypalPanel(paypal, base)}
${config ? retentionPanel({ report, config, base }) : ''}
${holdsPanel({ holds, base })}
<div class="panel"><h2>Downloads (${exports.length})</h2><div style="padding:12px 16px;font-size:14px">${exports.length
    ? exports.slice(0, 50).map((r) => `<div>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))} · family #${esc(r.subject_id)} · ${esc(r.requested_by)}</div>`).join('')
    : 'None yet.'}</div></div>`;
}
