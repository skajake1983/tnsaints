/**
 * The CRM screens: pipeline board, contact list, contact and family pages,
 * tasks, customers, add a contact, and the evaluation import.
 *
 * Plain HTML forms with post-redirect-get and no script, so they work under
 * the admin's deny-all CSP. Moving a card is a "Move to" select and a button —
 * usable by keyboard and screen reader, not drag-only. One-to-one email opens
 * the user's own mail program (mailto:); the site's email allowance is never
 * used for it.
 */

import { esc } from './ui.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';
import {
  PIPELINES, PIPELINE_LABELS, CONTACT_KINDS, KIND_LABELS, LOGGED_KINDS, TASK_VIEWS, centralToday,
} from '../crm/store.js';

export const CRM_STYLES = `
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin: 0 0 16px; }
  .tabs a { padding:6px 12px; border-radius:999px; font-size:14px; font-weight:700; color:var(--navy);
            text-decoration:none; border:1px solid var(--line); background:#fff; }
  .tabs a[aria-current="page"] { background:var(--navy); color:#fff; border-color:var(--navy); }
  .board { display:flex; gap:12px; overflow-x:auto; padding-bottom:8px; align-items:flex-start; }
  .col { flex:0 0 240px; background:#f4f6fa; border:1px solid var(--line); border-radius:10px; padding:8px; }
  .col h2 { font-size:13px; margin:2px 4px 8px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .col h2 .n { color:var(--ink); }
  .crd { background:#fff; border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:14px; }
  .crd a.t { font-weight:700; color:var(--navy); text-decoration:none; }
  .crd a.t:hover, .crd a.t:focus-visible { text-decoration:underline; }
  .crd .who, .crd .meta { color:var(--muted); font-size:12px; }
  .crd form, .row-form { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; align-items:center; }
  .crd select, .row-form select, .row-form input, .grid input, .grid select, .grid textarea { font:inherit; font-size:14px;
            padding:6px 8px; min-height:36px; border:1px solid var(--line); border-radius:6px; background:#fff; }
  .crd button, .row-form button, .grid button, .act { font:inherit; font-size:14px; padding:6px 12px; min-height:36px;
            border:1px solid var(--navy); background:var(--navy); color:#fff; border-radius:6px; cursor:pointer; }
  .act.light { background:#fff; color:var(--navy); }
  .act.danger { background:#fff; color:var(--danger); border-color:var(--danger); }
  .closed { opacity:.7; }
  .dnc { display:inline-block; font-size:11px; font-weight:700; padding:1px 7px; border-radius:99px;
         background:#f6e5e5; color:var(--danger); }
  .two { display:grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap:18px; align-items:start; }
  .pad { padding:12px 16px; }
  .facts { margin:0; display:grid; grid-template-columns: max-content 1fr; gap:4px 14px; font-size:14px; }
  .facts dt { color:var(--muted); }
  .facts dd { margin:0; }
  .grid { display:grid; gap:10px; }
  .grid label { font-weight:600; font-size:14px; display:block; margin-bottom:3px; }
  .grid .hint { color:var(--muted); font-size:12px; }
  .grid .err { color:var(--danger); font-size:13px; }
  .grid textarea { width:100%; min-height:90px; box-sizing:border-box; }
  .grid input[type=text], .grid input[type=email], .grid input[type=tel] { width:100%; box-sizing:border-box; }
  ol.timeline { list-style:none; margin:0; padding:0; }
  ol.timeline li { padding:10px 16px; border-bottom:1px solid var(--line); font-size:14px; }
  ol.timeline li:last-child { border-bottom:0; }
  ol.timeline .when { color:var(--muted); font-size:12px; }
  ol.timeline .body { white-space:pre-wrap; margin-top:3px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:14px; }
  .filters label { display:block; font-size:12px; font-weight:700; color:var(--muted); }
  .filters input, .filters select { font:inherit; font-size:14px; padding:6px 8px; min-height:36px;
            border:1px solid var(--line); border-radius:6px; }
  @media (max-width: 760px) {
    .two { grid-template-columns: 1fr; }
    .board { flex-direction:column; overflow-x:visible; }
    .col { flex:1 1 auto; width:100%; box-sizing:border-box; }
  }
`;

export const CRM_MESSAGES = {
  moved: 'Moved.',
  same: 'It was already at that stage.',
  conflict: 'That child already has an open card. Close the other one first.',
  invalid: 'That did not look right, so nothing was changed. Check the form and try again.',
  'not-found': 'That record no longer exists or has been closed.',
  logged: 'Logged.',
  saved: 'Saved.',
  created: 'Added.',
  exists: 'Someone with that email is already in the CRM — here they are.',
  merged: 'Merged.',
  anonymized: 'Anonymized. Their details are gone and cannot be recovered.',
  linked: 'Linked to their portal family.',
  'no-family': 'No portal family has a guardian with that email.',
  'task-created': 'Task added.',
  'task-updated': 'Task updated.',
  imported: 'Imported.',
  confirm: 'Tick the box to confirm. This cannot be undone.',
};

const when = (v) => (v
  ? new Date(v).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' })
  : '');
const money = (cents) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
const ownerName = (email, owners) => (email ? owners.find((o) => o.email === email)?.display_name || email : 'Nobody');
const grade = (level, year) => {
  const g = currentGrade(level, year);
  return g === null ? '' : gradeLabel(g);
};
const notice = (message) => (message && CRM_MESSAGES[message] ? `<div class="notice" role="status">${esc(CRM_MESSAGES[message])}</div>` : '');

export function crmTabs(current, base, { canAdmin = false } = {}) {
  const tabs = [
    ['board', '/crm', 'Pipeline'], ['list', '/crm/list', 'Contacts'], ['tasks', '/crm/tasks', 'Tasks'],
    ['customers', '/crm/customers', 'Customers'], ['inbox', '/inbox', 'Inbox'], ['new', '/crm/contacts/new', 'Add a contact'],
  ];
  if (canAdmin) tabs.push(['import', '/crm/import', 'Import']);
  return `<nav class="tabs" aria-label="CRM">${tabs
    .map(([k, href, label]) => `<a href="${esc(base + href)}"${k === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`)
    .join('')}</nav>`;
}

/** Staff choices. As a filter (`any`): '' = anyone, 'none' = nobody. As a value: '' = nobody. */
function ownerOptions(owners, selected, { any = false } = {}) {
  const choices = any ? [['', 'Anyone'], ['none', 'Nobody']] : [['', 'Nobody']];
  for (const o of owners) choices.push([o.email, o.display_name || o.email]);
  return choices
    .map(([value, text]) => `<option value="${esc(value)}"${value === (selected || '') ? ' selected' : ''}>${esc(text)}</option>`)
    .join('');
}

function cardHref(card, base) {
  return card.household_id ? `${base}/crm/families/${card.household_id}` : `${base}/crm/contacts/${card.contact_id}`;
}

function moveForm(card, stages, base, back) {
  const options = stages
    .map((s) => `<option value="${esc(s.stage)}"${s.stage === card.stage ? ' selected' : ''}>${esc(s.label)}</option>`)
    .join('');
  return `<form method="post" action="${esc(base)}/crm/cards/${esc(card.id)}/move">
  <input type="hidden" name="back" value="${esc(back)}">
  <label class="sr" for="mv${esc(card.id)}">Move ${esc(card.title)} to</label>
  <select id="mv${esc(card.id)}" name="stage">${options}</select><button type="submit">Move</button></form>`;
}

/** Pipeline board: a column per stage. */
export function boardBody({ pipeline, stages, cards, owners, owner, canWrite, canAdmin, base, message }) {
  const back = `/crm?pipeline=${pipeline}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`;
  const pipes = PIPELINES.filter((p) => p !== 'donor' || cards.length || pipeline === 'donor');
  const columns = stages
    .map((s) => {
      const here = cards.filter((c) => c.stage === s.stage);
      return `<section class="col" aria-labelledby="st-${esc(s.stage)}">
  <h2 id="st-${esc(s.stage)}">${esc(s.label)} <span class="n">${here.length}</span></h2>
  ${here.map((c) => `<article class="crd${c.closed_at ? ' closed' : ''}">
    <a class="t" href="${esc(cardHref(c, base))}">${esc(c.title)}</a>${c.do_not_contact ? ' <span class="dnc">Do not contact</span>' : ''}
    ${c.who ? `<div class="who">${esc(c.who)}</div>` : ''}
    <div class="meta">${esc(ownerName(c.owner_email, owners))} · ${esc(when(c.updated_at))}${c.closed_at ? ' · closed' : ''}</div>
    ${canWrite ? moveForm(c, stages, base, back) : ''}
  </article>`).join('') || '<p class="who" style="margin:4px">None</p>'}
</section>`;
    })
    .join('');
  return `<h1>CRM</h1>
${crmTabs('board', base, { canAdmin })}
<p class="sub">Every open card, plus those closed in the last 30 days. Family cards are per child.</p>
${notice(message)}
<form class="filters" method="get" action="${esc(base)}/crm">
  <div><label for="pl">Pipeline</label><select id="pl" name="pipeline">${pipes
    .map((p) => `<option value="${p}"${p === pipeline ? ' selected' : ''}>${esc(PIPELINE_LABELS[p])}</option>`).join('')}</select></div>
  <div><label for="ow">Owner</label><select id="ow" name="owner">${ownerOptions(owners, owner, { any: true })}</select></div>
  <div><button class="act" type="submit">Show</button></div>
</form>
<div class="board">${columns}</div>`;
}

/** Contacts list with filters and a CSV link. */
export function listBody({ rows, filters, stages, owners, canExport, canAdmin, base }) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString();
  const stageOptions = [...stages.entries()]
    .flatMap(([p, list]) => list.map((s) => [`${p}:${s.stage}`, `${PIPELINE_LABELS[p]}: ${s.label}`]))
    .map(([v, l]) => `<option value="${esc(v)}"${filters.stage === v ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');
  const table = rows.length
    ? `<div class="panel"><div class="scroll"><table class="stack">
<thead><tr><th>Name</th><th>Kind</th><th>Email</th><th>Phone</th><th>Open cards</th><th>Owner</th><th>Last contact</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
  <td data-label="Player"><a href="${esc(base)}/crm/contacts/${esc(r.id)}">${esc(r.name || '(no name)')}</a>${r.organization ? ` · ${esc(r.organization)}` : ''}${r.do_not_contact ? ' <span class="dnc">Do not contact</span>' : ''}</td>
  <td data-label="Kind">${esc(KIND_LABELS[r.kind] || r.kind)}</td>
  <td data-label="Email">${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}</td>
  <td data-label="Phone">${esc(r.phone || '')}</td>
  <td data-label="Open cards">${esc(r.open_stages || '')}</td>
  <td data-label="Owner">${esc(ownerName(r.owner_email, owners))}</td>
  <td data-label="Last contact">${esc(when(r.last_contact))}</td>
</tr>`).join('')}</tbody></table></div></div>`
    : '<div class="empty">No contacts match.</div>';
  return `<h1>CRM</h1>
${crmTabs('list', base, { canAdmin })}
<p class="sub">People who are not (yet) portal families: leads, coaches, volunteers and sponsors. Portal families are under Customers.</p>
<form class="filters" method="get" action="${esc(base)}/crm/list">
  <div><label for="q">Search</label><input id="q" name="q" type="search" value="${esc(filters.q)}" maxlength="80"></div>
  <div><label for="kind">Kind</label><select id="kind" name="kind"><option value="">Any</option>${CONTACT_KINDS
    .map((k) => `<option value="${k}"${filters.kind === k ? ' selected' : ''}>${esc(KIND_LABELS[k])}</option>`).join('')}</select></div>
  <div><label for="stage">Card at</label><select id="stage" name="stage"><option value="">Any stage</option>${stageOptions}</select></div>
  <div><label for="owner">Owner</label><select id="owner" name="owner">${ownerOptions(owners, filters.owner, { any: true })}</select></div>
  <div><label><input type="checkbox" name="dnc" value="1"${filters.dnc ? ' checked' : ''}> Do not contact only</label></div>
  <div><button class="act" type="submit">Filter</button></div>
</form>
<p class="sub">${rows.length}${rows.length === 500 ? '+' : ''} ${rows.length === 1 ? 'contact' : 'contacts'}${canExport
    ? ` · <a href="${esc(base)}/crm/list.csv${qs ? `?${esc(qs)}` : ''}">Download as CSV</a> (recorded)` : ''}</p>
${table}`;
}

function activityLine(a, stageLabel) {
  let detail = {};
  try { detail = JSON.parse(a.detail || '{}'); } catch { detail = {}; }
  const label = {
    note: 'Note', call: 'Call', email: 'Email', text: 'Text message', meeting: 'Meeting',
    stage: `Moved from ${stageLabel(detail.from)} to ${stageLabel(detail.to)}${detail.via ? ` (${detail.via})` : ''}`,
    linked: 'Matched to a portal family', enrolled: `Enrolled${detail.from ? ` (was ${stageLabel(detail.from)})` : ''}`,
    merge: 'Another contact was merged into this one', import: 'Added from a past evaluation',
    dnc: detail.on ? 'Marked do not contact' : 'Do not contact removed',
  }[a.kind] || a.kind;
  return { label, body: a.body, by: a.actor === 'system' ? '' : a.actor };
}

function timeline(items) {
  if (!items.length) return '<div class="empty">Nothing yet.</div>';
  return `<ol class="timeline">${items
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, 200)
    .map((i) => `<li><strong>${esc(i.label)}</strong>${i.by ? ` <span class="when">by ${esc(i.by)}</span>` : ''}
  <div class="when">${esc(when(i.at))}</div>${i.body ? `<div class="body">${esc(i.body)}</div>` : ''}</li>`)
    .join('')}</ol>`;
}

function stageLabeller(stages) {
  const labels = new Map();
  for (const list of stages.values()) for (const s of list) labels.set(s.stage, s.label);
  return (stage) => labels.get(stage) || stage || '?';
}

const INQUIRY_LABEL = { general: 'Website inquiry', player: 'Academy interest (website)', coaching: 'Coaching interest (website)',
  sponsor: 'Sponsorship interest (website)', volunteer: 'Volunteer interest (website)' };

function inquiryItems(inquiries) {
  return inquiries.map((q) => {
    let fields = {};
    try { fields = JSON.parse(q.fields || '{}'); } catch { fields = {}; }
    const extra = [fields.player_name, fields.grade, fields.school, fields.position, fields.role, fields.organization]
      .filter(Boolean).join(' · ');
    return { at: q.received_at, label: INQUIRY_LABEL[q.purpose] || 'Website inquiry', body: [extra, q.message].filter(Boolean).join('\n') };
  });
}

function taskPanel({ tasks, owners, canWrite, base, back, contactId = '', householdId = '', heading = 'Tasks', list = true }) {
  const open = tasks.filter((t) => t.status === 'open');
  return `<div class="panel"><h2>${esc(heading)}</h2>
${!list ? '' : open.length ? `<div class="scroll"><table><tbody>${open.map((t) => `<tr>
  <td>${esc(t.title)}</td><td>${esc(t.due_on || 'No date')}</td><td>${esc(ownerName(t.owner_email, owners))}</td>
  <td>${canWrite ? `<form class="row-form" method="post" action="${esc(base)}/crm/tasks/${esc(t.id)}/done">
    <input type="hidden" name="back" value="${esc(back)}"><button type="submit">Done</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No open tasks.</div>'}
${canWrite ? `<form class="grid pad" method="post" action="${esc(base)}/crm/tasks">
  <input type="hidden" name="back" value="${esc(back)}">
  ${contactId ? `<input type="hidden" name="contact_id" value="${esc(contactId)}">` : ''}
  ${householdId ? `<input type="hidden" name="household_id" value="${esc(householdId)}">` : ''}
  <div><label for="tt">New task</label><input id="tt" name="title" type="text" maxlength="140" required></div>
  <div class="row-form" style="margin:0">
    <label class="sr" for="td">Due</label><input id="td" name="due_on" type="date" value="${esc(centralToday())}">
    <label class="sr" for="to">Owner</label><select id="to" name="owner">${ownerOptions(owners, '')}</select>
    <button type="submit">Add task</button></div>
</form>` : ''}</div>`;
}

function logForm({ action, base, back }) {
  return `<form class="grid pad" method="post" action="${esc(base)}${esc(action)}">
  <input type="hidden" name="back" value="${esc(back)}">
  <div class="row-form" style="margin:0">
    <label class="sr" for="lk">What</label><select id="lk" name="kind">${LOGGED_KINDS
    .map((k) => `<option value="${k}">${esc({ note: 'Note', call: 'Call', email: 'Email', text: 'Text message', meeting: 'Meeting' }[k])}</option>`).join('')}</select>
    <label class="sr" for="lo">When</label><input id="lo" name="occurred_on" type="date" value="${esc(centralToday())}" max="${esc(centralToday())}">
  </div>
  <div><label for="lb">Notes</label><textarea id="lb" name="body" maxlength="4000"></textarea>
    <div class="hint">Staff only. Never sent to the family. Don't record medical details here.</div></div>
  <div><button type="submit">Log it</button></div>
</form>`;
}

function ownerForm({ action, owners, current, base, back }) {
  return `<form class="row-form" method="post" action="${esc(base)}${esc(action)}">
  <input type="hidden" name="back" value="${esc(back)}">
  <label for="own">Owner</label><select id="own" name="owner">${ownerOptions(owners, current || '')}</select>
  <button type="submit">Save</button></form>`;
}

function dncForm({ action, on, base, back }) {
  return `<form class="row-form" method="post" action="${esc(base)}${esc(action)}">
  <input type="hidden" name="back" value="${esc(back)}"><input type="hidden" name="on" value="${on ? '0' : '1'}">
  <button class="act ${on ? 'light' : 'danger'}" type="submit">${on ? 'Remove do not contact' : 'Mark do not contact'}</button></form>`;
}

function cardsPanel({ cards, stages, canWrite, base, back }) {
  return `<div class="panel"><h2>Pipeline cards</h2>${cards.length
    ? cards.map((c) => `<div class="crd${c.closed_at ? ' closed' : ''}" style="margin:8px 12px">
  <strong>${esc(c.title)}</strong> · ${esc(PIPELINE_LABELS[c.pipeline] || c.pipeline)}: ${esc(c.stage_label)}${c.closed_at ? ' (closed)' : ''}
  ${canWrite ? moveForm(c, stages.get(c.pipeline) || [], base, back) : ''}</div>`).join('')
    : '<div class="empty">No cards.</div>'}</div>`;
}

/** One contact. */
export function contactBody({ detail, stages, owners, canWrite, canAdmin, base, message }) {
  const { contact: c, prospects, cards, tasks, inquiries, activities, duplicates } = detail;
  const back = `/crm/contacts/${c.id}`;
  const label = stageLabeller(stages);
  const items = [
    ...activities.map((a) => ({ at: a.occurred_at, ...activityLine(a, label) })),
    ...inquiryItems(inquiries),
    ...tasks.filter((t) => t.status === 'done').map((t) => ({ at: t.completed_at, label: `Task done: ${t.title}` })),
  ];
  const active = c.status === 'active';
  const statusNote = {
    converted: c.household_id
      ? `This lead became a portal family. <a href="${esc(base)}/crm/families/${esc(c.household_id)}">Open ${esc(c.family_name || 'the family')}</a>.`
      : 'This lead became a portal family.',
    merged: `Merged into <a href="${esc(base)}/crm/contacts/${esc(c.merged_into_id)}">${esc(c.merged_into_name || `contact ${c.merged_into_id}`)}</a>.`,
    anonymized: 'Anonymized: their details were removed.',
  }[c.status];
  return `<h1>${esc(c.name || '(no name)')}${c.do_not_contact ? ' <span class="dnc">Do not contact</span>' : ''}</h1>
${crmTabs('', base, { canAdmin })}
<p class="sub">${esc(KIND_LABELS[c.kind] || c.kind)}${c.organization ? ` · ${esc(c.organization)}` : ''} · added ${esc(when(c.created_at))} from ${esc(c.source)}</p>
${notice(message)}
${statusNote ? `<div class="notice">${statusNote}</div>` : ''}
<div class="two"><div>
  <div class="panel"><h2>Details</h2><div class="pad"><dl class="facts">
    <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd>
    <dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : '—'}</dd>
    <dt>Owner</dt><dd>${esc(ownerName(c.owner_email, owners))}</dd>
    ${c.household_id && c.status === 'active' ? `<dt>Family</dt><dd><a href="${esc(base)}/crm/families/${esc(c.household_id)}">${esc(c.family_name || 'Portal family')}</a></dd>` : ''}
  </dl>
  ${prospects.length ? `<h3 style="font-size:14px;margin:12px 0 4px">Children</h3><ul style="margin:0;padding-left:18px">${prospects
    .map((p) => `<li>${esc(p.player_name || p.name || '(removed)')}${grade(p.grade_level, p.grade_school_year) ? ` · ${esc(grade(p.grade_level, p.grade_school_year))}` : ''}${p.school ? ` · ${esc(p.school)}` : ''}${p.position ? ` · ${esc(p.position)}` : ''}</li>`).join('')}</ul>` : ''}
  ${canWrite && active ? `<div style="margin-top:12px">${ownerForm({ action: `/crm/contacts/${c.id}/owner`, owners, current: c.owner_email, base, back })}
    ${dncForm({ action: `/crm/contacts/${c.id}/dnc`, on: c.do_not_contact, base, back })}</div>` : ''}
  </div></div>
  ${cardsPanel({ cards, stages, canWrite: canWrite && active, base, back })}
  <div class="panel"><h2>Timeline</h2>${canWrite && active ? logForm({ action: `/crm/contacts/${c.id}/activity`, base, back }) : ''}${timeline(items)}</div>
</div><div>
  ${taskPanel({ tasks, owners, canWrite: canWrite && active, base, back, contactId: c.id })}
  ${active && canWrite ? `<div class="panel"><h2>Link to a portal family</h2>
    <form class="grid pad" method="post" action="${esc(base)}/crm/contacts/${esc(c.id)}/link">
    <div><label for="ge">A guardian's portal email</label><input id="ge" name="guardian_email" type="email" maxlength="254" required>
    <div class="hint">For when they signed up with a different address than they wrote from.</div></div>
    <div><button type="submit">Link</button></div></form></div>` : ''}
  ${duplicates.length ? `<div class="panel"><h2>Possible duplicates (same phone)</h2><ul class="pad" style="margin:0 0 0 14px">${duplicates
    .map((d) => `<li><a href="${esc(base)}/crm/contacts/${esc(d.id)}">${esc(d.name || '(no name)')}</a> · ${esc(KIND_LABELS[d.kind] || d.kind)}${d.email ? ` · ${esc(d.email)}` : ''}</li>`).join('')}</ul></div>` : ''}
  ${canAdmin && active ? `<div class="panel"><h2>Merge or anonymize</h2>
    <form class="grid pad" method="post" action="${esc(base)}/crm/contacts/${esc(c.id)}/merge">
      <div><label for="into">Merge this contact into contact number</label><input id="into" name="into_id" type="text" inputmode="numeric" pattern="[0-9]{1,12}" required>
      <div class="hint">Everything here moves to that contact; this one keeps only a pointer.</div></div>
      <div><button type="submit">Merge</button></div></form>
    <form class="grid pad" method="post" action="${esc(base)}/crm/contacts/${esc(c.id)}/anonymize">
      <div><label><input type="checkbox" name="confirm" value="yes" required> I understand this removes their name, email, phone, children's names, messages and staff notes for good.</label></div>
      <div><button class="act danger" type="submit">Anonymize</button></div></form></div>` : ''}
</div></div>`;
}

const PLACE = { applied: 'Applied', waitlist: 'Waiting list', offered: 'Offered a seat', active: 'Enrolled', past_due: 'Payment past due',
  declined: 'Declined', cancelled: 'Cancelled', ended: 'Ended' };

/** One portal family, read live. */
export function familyBody({ detail, stages, owners, canWrite, canAdmin, base, message }) {
  const { household: h, guardians, children, enrollments, payments, subscriptions, cards, tasks, activities, inquiries,
    evalMessages } = detail;
  const back = `/crm/families/${h.id}`;
  const label = stageLabeller(stages);
  const items = [
    ...activities.map((a) => ({ at: a.occurred_at, ...activityLine(a, label) })),
    ...inquiryItems(inquiries),
    ...tasks.filter((t) => t.status === 'done').map((t) => ({ at: t.completed_at, label: `Task done: ${t.title}` })),
    ...enrollments.flatMap((e) => [
      { at: e.applied_at, label: `${e.child_name} applied to ${e.program_name}` },
      e.offered_at ? { at: e.offered_at, label: `${e.child_name} offered a seat${e.group_name ? ` in ${e.group_name}` : ''}` } : null,
      e.activated_at ? { at: e.activated_at, label: `${e.child_name} enrolled${e.group_name ? ` in ${e.group_name}` : ''}` } : null,
      e.ended_at ? { at: e.ended_at, label: `${e.child_name}'s place ended (${PLACE[e.status] || e.status})` } : null,
    ].filter(Boolean)),
    ...payments.map((p) => ({ at: p.paid_at, label: `${p.amount_cents < 0 ? 'Refunded' : 'Paid'} ${money(Math.abs(p.amount_cents))} (${p.kind.replace('_', ' ')})` })),
    ...evalMessages.map((m) => ({ at: m.sent_at, label: `Evaluation feedback emailed about ${m.player_name}` })),
  ];
  return `<h1>${esc(h.display_name || 'Portal family')}${h.do_not_contact ? ' <span class="dnc">Do not contact</span>' : ''}</h1>
${crmTabs('', base, { canAdmin })}
<p class="sub">Portal family since ${esc(when(h.created_at))}. Their details are the family's own, from the portal.</p>
${notice(message)}
<div class="two"><div>
  <div class="panel"><h2>Guardians</h2><div class="scroll"><table><tbody>${guardians.map((g) => `<tr>
    <td>${esc(g.display_name || '')}${g.relationship ? ` (${esc(g.relationship)})` : ''}</td>
    <td><a href="mailto:${esc(g.email)}">${esc(g.email)}</a></td><td>${esc(g.phone || '')}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel"><h2>Children and places</h2><div class="scroll"><table class="stack">
    <thead><tr><th>Child</th><th>Grade</th><th>Places</th></tr></thead><tbody>${children.map((c) => {
    const places = enrollments.filter((e) => e.child_name === c.display_name)
      .map((e) => `${e.program_name}: ${PLACE[e.status] || e.status}${e.group_name ? ` (${e.group_name})` : ''}`);
    return `<tr><td data-label="Player">${esc(c.display_name)}</td><td data-label="Grade">${esc(grade(c.grade_level, c.grade_school_year))}</td>
      <td data-label="Places">${esc(places.join('; ') || 'None')}</td></tr>`;
  }).join('') || '<tr><td colspan="3">No children added yet.</td></tr>'}</tbody></table></div></div>
  <div class="panel"><h2>Payments</h2><div class="pad">${subscriptions.length ? subscriptions
    .map((s) => `<div>PayPal subscription ${esc(s.paypal_subscription_id)}: ${esc(s.status)}${s.next_billing_at ? `, next ${esc(when(s.next_billing_at))}` : ''}</div>`).join('')
    : '<div>No subscription.</div>'}
    ${payments.length ? `<div class="sub" style="margin:6px 0 0">Last paid ${esc(when(payments.find((p) => p.amount_cents > 0)?.paid_at))}</div>` : ''}</div></div>
  ${cardsPanel({ cards, stages, canWrite, base, back })}
  <div class="panel"><h2>Timeline</h2>${canWrite ? logForm({ action: `/crm/families/${h.id}/activity`, base, back }) : ''}${timeline(items)}</div>
</div><div>
  <div class="panel"><h2>Looking after them</h2><div class="pad">
    <div>Owner: ${esc(ownerName(h.owner_email, owners))}</div>
    ${canWrite ? `${ownerForm({ action: `/crm/families/${h.id}/owner`, owners, current: h.owner_email, base, back })}
    ${dncForm({ action: `/crm/families/${h.id}/dnc`, on: h.do_not_contact, base, back })}` : ''}</div></div>
  ${taskPanel({ tasks, owners, canWrite, base, back, householdId: h.id })}
</div></div>`;
}

/** Tasks. */
export function tasksBody({ view, rows, counts, owners, owner, canWrite, canAdmin, base, message }) {
  const back = `/crm/tasks?view=${view}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`;
  const labels = { today: 'Today', overdue: 'Overdue', week: 'This week', open: 'All open', done: 'Done' };
  const tabs = TASK_VIEWS.map((v) => `<a href="${esc(base)}/crm/tasks?view=${v}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}"${v === view ? ' aria-current="page"' : ''}>${esc(labels[v])}${counts[v] !== undefined ? ` (${counts[v]})` : ''}</a>`).join('');
  const today = centralToday();
  const table = rows.length
    ? `<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Task</th><th>Due</th><th>About</th><th>Owner</th><th></th></tr></thead>
<tbody>${rows.map((t) => {
      const about = t.household_id ? `${base}/crm/families/${t.household_id}` : t.contact_id ? `${base}/crm/contacts/${t.contact_id}` : '';
      const acts = !canWrite ? '' : t.status === 'open'
        ? ['done', 'cancelled'].map((s) => `<form class="row-form" method="post" action="${esc(base)}/crm/tasks/${esc(t.id)}/${s}" style="margin:0">
            <input type="hidden" name="back" value="${esc(back)}"><button class="act${s === 'cancelled' ? ' light' : ''}" type="submit">${s === 'done' ? 'Done' : 'Cancel'}</button></form>`).join('')
        : `<form class="row-form" method="post" action="${esc(base)}/crm/tasks/${esc(t.id)}/open" style="margin:0">
            <input type="hidden" name="back" value="${esc(back)}"><button class="act light" type="submit">Reopen</button></form>`;
      return `<tr><td data-label="Player">${esc(t.title)}</td>
  <td data-label="Due">${esc(t.due_on || '')}${t.status === 'open' && t.due_on && t.due_on < today ? ' <span class="dnc">overdue</span>' : ''}</td>
  <td data-label="About">${about ? `<a href="${esc(about)}">${esc(t.about || 'Open')}</a>` : ''}</td>
  <td data-label="Owner">${esc(ownerName(t.owner_email, owners))}</td>
  <td data-label="Admin"><div class="row-form" style="margin:0">${acts}</div></td></tr>`;
    }).join('')}</tbody></table></div></div>`
    : '<div class="empty">Nothing here.</div>';
  return `<h1>CRM</h1>
${crmTabs('tasks', base, { canAdmin })}
${notice(message)}
<nav class="tabs" aria-label="Task views">${tabs}</nav>
<form class="filters" method="get" action="${esc(base)}/crm/tasks"><input type="hidden" name="view" value="${esc(view)}">
  <div><label for="tow">Owner</label><select id="tow" name="owner">${ownerOptions(owners, owner, { any: true })}</select></div>
  <div><button class="act" type="submit">Show</button></div></form>
${table}
${canWrite ? taskPanel({ tasks: [], owners, canWrite, base, back, heading: 'Add a task', list: false }) : ''}`;
}

/** Customers: every family with a place, applied or waiting included. */
export function customersBody({ rows, owners, canAdmin, base }) {
  const table = rows.length
    ? `<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Family</th><th>Children and places</th><th>Payment</th><th>Owner</th><th>Last contact</th></tr></thead>
<tbody>${rows.map((f) => `<tr>
  <td data-label="Player"><a href="${esc(base)}/crm/families/${esc(f.id)}">${esc(f.display_name || 'Family')}</a>${f.do_not_contact ? ' <span class="dnc">Do not contact</span>' : ''}</td>
  <td data-label="Places">${f.places.map((p) => esc(`${p.child_name}: ${p.program_name} ${PLACE[p.status] || p.status}${p.group_name ? ` (${p.group_name})` : ''}`)).join('<br>') || 'No current place'}</td>
  <td data-label="Payment">${esc(f.subscription_status || 'No subscription')}${f.last_paid ? ` · last paid ${esc(when(f.last_paid))}` : ''}</td>
  <td data-label="Owner">${esc(ownerName(f.owner_email, owners))}</td>
  <td data-label="Last contact">${esc(when(f.last_contact))}</td></tr>`).join('')}</tbody></table></div></div>`
    : '<div class="empty">No families with a place yet.</div>';
  return `<h1>CRM</h1>
${crmTabs('customers', base, { canAdmin })}
<p class="sub">Every portal family with a place in a program — applied, waiting, offered, enrolled or past due — read live from the portal.</p>
${table}`;
}

/** Add a contact by hand. */
export function newContactBody({ values = {}, errors = {}, owners, canAdmin, base }) {
  const v = (k) => esc(values[k] || '');
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}">${esc(errors[k])}</div>` : '');
  const desc = (k) => (errors[k] ? ` aria-describedby="e-${k}" aria-invalid="true"` : '');
  return `<h1>CRM</h1>
${crmTabs('new', base, { canAdmin })}
<p class="sub">Someone who got in touch by phone, in person or by email. Required: a name, and an email or phone.</p>
${Object.keys(errors).length ? '<div class="notice" role="alert">Please fix the highlighted fields.</div>' : ''}
<form class="grid panel pad" method="post" action="${esc(base)}/crm/contacts/new" novalidate>
  <div><label for="kind">Kind (required)</label><select id="kind" name="kind"${desc('kind')}>${CONTACT_KINDS
    .map((k) => `<option value="${k}"${values.kind === k ? ' selected' : ''}>${esc(KIND_LABELS[k])}</option>`).join('')}</select>${err('kind')}</div>
  <div><label for="name">Name (required)</label><input id="name" name="name" type="text" maxlength="80" value="${v('name')}"${desc('name')}>${err('name')}</div>
  <div><label for="email">Email</label><input id="email" name="email" type="email" maxlength="254" value="${v('email')}"${desc('email')}>${err('email')}</div>
  <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" maxlength="30" value="${v('phone')}"${desc('phone')}>
    <div class="hint">Like (615) 555-0142.</div>${err('phone')}</div>
  <div><label for="organization">Organization</label><input id="organization" name="organization" type="text" maxlength="120" value="${v('organization')}"${desc('organization')}>${err('organization')}</div>
  <div><label for="child_name">Child's name (families)</label><input id="child_name" name="child_name" type="text" maxlength="80" value="${v('child')}"${desc('child_name')}>
    <div class="hint">Family cards are per child. Add one here; more come from their website form or portal account.</div>${err('child_name')}</div>
  <div><label for="child_grade">Child's grade</label><input id="child_grade" name="child_grade" type="text" maxlength="10" value="${v('grade')}"${desc('child_grade')}>
    <div class="hint">Like 4th.</div>${err('child_grade')}</div>
  <div><label for="owner">Owner</label><select id="owner" name="owner">${ownerOptions(owners, values.owner || '')}</select></div>
  <div><button type="submit">Add contact</button></div>
</form>`;
}

/** The evaluation import. */
export function importBody({ preview, canAdmin, base, message, result }) {
  return `<h1>CRM</h1>
${crmTabs('import', base, { canAdmin })}
<p class="sub">Families who registered for past evaluations, into the pipeline: one contact per parent email, one card per child.
Families with a portal account get a card on their family instead of a contact. Running it twice adds nothing twice.</p>
${notice(message)}
${result ? `<div class="notice" role="status">${esc(`${result.contacts} contacts and ${result.cards} cards added.`)}</div>` : ''}
<div class="panel"><h2>What an import would do now</h2><div class="pad"><dl class="facts">
  <dt>Evaluations</dt><dd>${esc(preview.events)}</dd>
  <dt>Families</dt><dd>${esc(preview.families)} (${esc(preview.portalFamilies)} already have a portal account)</dd>
  <dt>Children</dt><dd>${esc(preview.children)}</dd>
  <dt>New contacts</dt><dd>${esc(preview.newContacts)}</dd>
  <dt>New cards</dt><dd>${esc(preview.newCards)}</dd>
</dl>
${preview.newContacts || preview.newCards ? `<form method="post" action="${esc(base)}/crm/import" style="margin-top:12px">
  <button class="act" type="submit">Import</button></form>` : '<p class="sub" style="margin:12px 0 0">Nothing new to import.</p>'}
</div></div>`;
}
