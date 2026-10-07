/**
 * Program settings: the academy's price, groups and waiver, and the switch
 * that opens it to families.
 *
 * Everything the owner has to supply before families can apply (plan items
 * O5 price, O8 groups, O9 waiver) is entered here rather than sent to a
 * developer. The page says in words what is still missing, and the database's
 * own CHECK constraints refuse to open a program without a price, a PayPal
 * plan and a waiver, whatever this page does.
 *
 * No script; plain forms, post-redirect-get.
 */

import { esc } from './ui.js';
import { detailsPanel } from './programs-list-ui.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const PROGRAM_STYLES = `
  .form-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; padding: 14px 16px; }
  .form-grid label { display:block; font-size: 13px; font-weight: 700; color: var(--muted); margin-bottom: 4px; }
  .form-grid input, .form-grid select, .form-grid textarea { width: 100%; font: inherit; font-size: 15px; padding: 8px 10px;
    border: 1px solid #9aa7bb; border-radius: 8px; background: #fff; }
  .form-grid .wide { grid-column: 1 / -1; }
  .form-actions { padding: 0 16px 16px; display:flex; gap: 10px; flex-wrap: wrap; }
  .form-actions button { font: inherit; font-weight: 700; padding: 9px 16px; border-radius: 8px; border: 0;
    background: var(--navy); color: #fff; cursor: pointer; }
  .form-actions button.secondary { background: #fff; color: var(--navy); border: 2px solid var(--navy); }
  .missing li { margin-bottom: 4px; }
  details.group { border-top: 1px solid var(--line); }
  details.group summary { padding: 12px 16px; cursor: pointer; font-weight: 700; }
  textarea.waiver-text { min-height: 220px; font-family: inherit; }
`;

const MESSAGES = {
  created: 'Program created as a draft. Fill in its details, price, groups and waiver, then open it.',
  'details-saved': 'Details saved.',
  current: 'This is now the current evaluation.',
  cleared: 'The evaluation runs from the settings in wrangler.toml again.',
  saved: 'Settings saved.',
  opened: 'The program is open. Families can apply.',
  closed: 'The program is closed to new applications.',
  'cannot-open': 'The program cannot open yet — see what is missing below.',
  'group-saved': 'Group saved.',
  'waiver-saved': 'Waiver version saved. Choose it in the settings above to use it.',
  invalid: 'Something in that form was not valid. Nothing was changed.',
  'waiver-exists': 'A waiver with that name already exists. Waivers cannot be edited; add a new version instead.',
};

const dollars = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));

/** What still stands between this program and being open, in plain words. */
export function missingToOpen(program) {
  const missing = [];
  if (program.billing !== 'free' && (program.price_cents === null || program.price_cents === undefined)) {
    missing.push(program.billing === 'subscription' ? 'A monthly price' : 'A price');
  }
  if (program.billing === 'subscription' && !program.paypal_plan_id_live && !program.paypal_plan_id_sandbox) {
    missing.push('A PayPal plan ID');
  }
  if (!program.waiver_version_id) missing.push('A waiver for families to sign');
  return missing;
}

function input(name, label, value, { type = 'text', attrs = '', wide = false, hint = '' } = {}) {
  return `<div${wide ? ' class="wide"' : ''}><label for="${esc(name)}">${esc(label)}</label>
  <input id="${esc(name)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value ?? '')}" ${attrs}>
  ${hint ? `<div class="sub" style="margin:4px 0 0">${esc(hint)}</div>` : ''}</div>`;
}

function select(name, label, options, value) {
  return `<div><label for="${esc(name)}">${esc(label)}</label><select id="${esc(name)}" name="${esc(name)}">${options
    .map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`)
    .join('')}</select></div>`;
}

const GRADES = [['', '—'], ...Array.from({ length: 13 }, (_, g) => [String(g), g === 0 ? 'K' : String(g)])];

function groupForm(action, g = {}, base) {
  return `<form method="post" action="${esc(base)}${esc(action)}"><div class="form-grid">
  ${input('name', 'Group name', g.name, { attrs: 'required maxlength="60"', hint: 'Families see this, e.g. "Tuesday 3rd–4th grade".' })}
  ${input('schedule_summary', 'Schedule, as families should read it', g.schedule_summary,
    { attrs: 'required maxlength="100"', hint: 'e.g. "Tuesdays 6:00–7:30 PM"' })}
  ${select('weekday', 'Main day', [['', '—'], ...WEEKDAYS.map((d, i) => [String(i), d])], g.weekday)}
  ${input('start_time', 'Starts', g.start_time, { type: 'time' })}
  ${input('end_time', 'Ends', g.end_time, { type: 'time' })}
  ${input('location', 'Location', g.location, { attrs: 'maxlength="120"' })}
  ${input('starts_on', 'First session', g.starts_on, { type: 'date', hint: 'Monthly billing starts on this date.' })}
  ${input('capacity', 'Seats', g.capacity ?? 10, { type: 'number', attrs: 'required min="1" max="200"' })}
  ${select('grade_min', 'Lowest grade', GRADES, g.grade_min)}
  ${select('grade_max', 'Highest grade', GRADES, g.grade_max)}
  ${g.id ? select('status', 'Status', [['active', 'Active'], ['closed', 'Closed (no new offers)']], g.status) : ''}
</div><div class="form-actions"><button type="submit">${g.id ? 'Save group' : 'Add group'}</button></div></form>`;
}

function evaluationPanel(program, current, base) {
  if (program.kind !== 'evaluation') return '';
  return `<div class="panel"><h2>The current evaluation</h2><div style="padding:12px 16px">
${current
    ? `<p style="margin:0 0 8px"><strong>This is the current evaluation.</strong> Registration, the roster, notes, decisions and
emails all use it: its groups are the sessions, its seats the session size, its grades and close time the form's.</p>
<form method="post" action="${esc(base)}/programs/${esc(program.id)}/current"><input type="hidden" name="current" value="off">
<div class="form-actions" style="padding:0"><button class="secondary" type="submit">Stop: go back to the settings in wrangler.toml</button></div></form>`
    : `<p style="margin:0 0 8px">Make this the evaluation registration, the roster, notes and decisions use. Its groups are the
sessions (name them by time, e.g. "9:00 AM"), each group's seats the session size.</p>
<form method="post" action="${esc(base)}/programs/${esc(program.id)}/current"><input type="hidden" name="current" value="on">
<div class="form-actions" style="padding:0"><button type="submit">Make this the current evaluation</button></div></form>`}
</div></div>`;
}

export function programBody({ program, groups, waivers, message, base = '', evaluationCurrent = false }) {
  const missing = missingToOpen(program);
  const statusLine = program.status === 'open'
    ? '<strong>Open</strong> — families can apply.'
    : `<strong>${esc(program.status[0].toUpperCase() + program.status.slice(1))}</strong> — families cannot apply.`;
  const openClose = program.status === 'open'
    ? `<form method="post" action="${esc(base)}/programs/${esc(program.id)}/status"><input type="hidden" name="status" value="closed">
  <div class="form-actions" style="padding:0"><button class="secondary" type="submit">Close to new applications</button></div></form>`
    : `${missing.length ? `<p style="margin:8px 0 4px">Before it can open:</p><ul class="missing">${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
<form method="post" action="${esc(base)}/programs/${esc(program.id)}/status"><input type="hidden" name="status" value="open">
  <div class="form-actions" style="padding:0"><button type="submit"${missing.length ? ' disabled' : ''}>Open to families</button></div></form>`;

  const settings = `<form method="post" action="${esc(base)}/programs/${esc(program.id)}/settings"><div class="form-grid">
  ${program.billing === 'free' ? '' : input('price', program.billing === 'subscription' ? 'Monthly price ($)' : 'Price ($)', dollars(program.price_cents),
    { attrs: 'inputmode="decimal" pattern="[0-9]+(\\.[0-9]{2})?"',
      hint: program.billing === 'subscription' ? 'Must match the PayPal plan exactly.' : 'One payment, charged when the family signs up or accepts.' })}
  ${program.billing !== 'subscription' ? '' : input('setup_fee', 'One-time setup fee ($)', dollars(program.setup_fee_cents),
    { attrs: 'inputmode="decimal" pattern="[0-9]+(\\.[0-9]{2})?"', hint: 'Covers the practice shirt.' })}
  ${input('offer_hold_days', 'Days a family has to accept an offered seat', program.offer_hold_days,
    { type: 'number', attrs: 'min="1" max="30"' })}
  ${select('grade_min', 'Lowest grade', GRADES, program.grade_min)}
  ${select('grade_max', 'Highest grade', GRADES, program.grade_max)}
  ${program.billing !== 'subscription' ? '' : `${input('paypal_plan_id_live', 'PayPal plan ID (live)', program.paypal_plan_id_live, { attrs: 'maxlength="60" pattern="P-[A-Z0-9]+"' })}
  ${input('paypal_plan_id_sandbox', 'PayPal plan ID (sandbox, for testing)', program.paypal_plan_id_sandbox,
    { attrs: 'maxlength="60" pattern="P-[A-Z0-9]+"' })}`}
  ${select('waiver_version_id', 'Waiver families sign', [['', '— none —'], ...waivers.map((w) => [w.id, `${w.title} (${w.id})`])],
    program.waiver_version_id)}
</div><div class="form-actions"><button type="submit">Save settings</button></div></form>`;

  const groupList = groups.length
    ? groups
        .map((g) => `<details class="group"><summary>${esc(g.name)} — ${esc(g.schedule_summary)} · ${esc(g.taken)}/${esc(g.capacity)} seats${
          g.status !== 'active' ? ' · closed' : ''}</summary>${groupForm(`/programs/${program.id}/groups/${g.id}`, g, base)}</details>`)
        .join('')
    : '<div class="empty">No groups yet.</div>';

  const waiverForm = `<form method="post" action="${esc(base)}/programs/${esc(program.id)}/waivers"><div class="form-grid">
  ${input('legal_entity', 'Who families are agreeing with (legal name)', '', { attrs: 'required maxlength="120"', wide: true,
    hint: 'e.g. "Tennessee Saints Basketball Academy LLC". When the non-profit takes over, add a new version naming it.' })}
  ${input('title', 'Title', 'Participation waiver and release', { attrs: 'required maxlength="120"', wide: true })}
  <div class="wide"><label for="body_text">Full text (as approved)</label>
  <textarea id="body_text" name="body_text" class="waiver-text" required maxlength="20000"></textarea></div>
</div><div class="form-actions"><button type="submit">Save as a new version</button></div>
<p class="sub" style="padding:0 16px 14px;margin:0">A saved version can never be edited — a signature only means something against the exact words signed.
To change the wording, save a new version and choose it above.</p></form>`;

  return `<h1>${esc(program.name)}</h1>
<p class="sub">Price, groups and waiver for families applying through the parent portal.</p>
${message && MESSAGES[message] ? `<div class="notice" role="status">${esc(MESSAGES[message])}</div>` : ''}
<div class="panel"><h2>Status</h2><div style="padding:12px 16px">${statusLine}${openClose}</div></div>
${evaluationPanel(program, evaluationCurrent, base)}
${detailsPanel({ program, base })}
<div class="panel"><h2>Settings</h2>${settings}</div>
<div class="panel"><h2>Groups</h2>${groupList}
  <details class="group"><summary>Add a group</summary>${groupForm(`/programs/${program.id}/groups`, {}, base)}</details></div>
<div class="panel"><h2>Waivers</h2><div style="padding:12px 16px">${waivers.length
    ? `<ul>${waivers.map((w) => `<li>${esc(w.title)} — <code>${esc(w.id)}</code>, with ${esc(w.legal_entity)}</li>`).join('')}</ul>`
    : 'No waiver versions yet.'}</div>
  <details class="group"><summary>Add a waiver version</summary>${waiverForm}</details></div>`;
}
