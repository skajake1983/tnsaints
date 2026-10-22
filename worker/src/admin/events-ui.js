/**
 * Events (the Events plan, 2026-10-21): the list, one event's page, and the
 * event picker on Roster, Evaluations and Decisions. No script: plain links
 * and forms, like the rest of the admin.
 */

import { esc, backButton } from './ui.js';
import { dateLine } from '../programs/evaluation.js';

const KIND = { evaluation: 'Evaluation', open_gym: 'Open gym', camp: 'Camp', scrimmage: 'Scrimmage', tournament: 'Tournament' };
const STATUS = { draft: 'Draft', open: 'Open for sign-ups', closed: 'Closed', archived: 'Archived' };

export const EVENT_STYLES = `
  .eventbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 14px; font-size: 14px; }
  .eventbar label { font-weight: 700; color: var(--muted); }
  .eventbar select { min-height: 40px; max-width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
  .eventbar button, .evactions button, .evactions a.btn { min-height: 40px; }
  .evactions { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 22px; }
  .evactions form { margin: 0; }
  .evactions a.btn { display: inline-flex; align-items: center; padding: 8px 14px; border: 1px solid var(--line);
    border-radius: 8px; background: #fff; color: var(--navy); font-weight: 700; text-decoration: none; font-size: 14px; }
`;

/** The day an event is on (or runs), for lists: "Saturday, August 29", or "—". */
export function whenLine(e) {
  return dateLine([e.first_day, e.last_day].filter(Boolean)) || '—';
}

/** Today in Central, YYYY-MM-DD. */
export function centralToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/** Open for sign-ups, coming up, or past. */
export function eventPhase(e, today) {
  if (e.status === 'open') return 'open';
  const last = e.last_day || e.first_day;
  return last && last < today ? 'past' : 'coming';
}

/** A form that shows an event on Roster, Evaluations or Decisions. */
function viewForm(base, id, returnTo, label, cls = '') {
  return `<form method="post" action="${esc(base)}/events/view">
  <input type="hidden" name="event" value="${esc(id)}"><input type="hidden" name="return" value="${esc(returnTo)}">
  <button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button></form>`;
}

function eventRows(events, base, canManage) {
  return events.map((e) => `<tr>
    <td data-label="Event">${canManage && !e.settings ? `<a href="${esc(base)}/events/${esc(e.id)}"><strong>${esc(e.name)}</strong></a>`
      : `<strong>${esc(e.name)}</strong>`}${e.is_current ? ' <span class="pill confirmed">current</span>' : ''}</td>
    <td data-label="Type">${esc(KIND[e.kind] || e.kind)}</td>
    <td data-label="When">${esc(whenLine(e))}</td>
    <td data-label="Status">${esc(e.settings ? 'From settings' : STATUS[e.status] || e.status)}</td>
    <td data-label="Signed up">${esc(e.confirmed)}${e.waiting ? ` · ${esc(e.waiting)} waiting` : ''}</td>
    <td data-label="">${viewForm(base, e.id, '/', 'Roster')}</td>
  </tr>`).join('');
}

function eventTable(title, events, base, canManage, empty) {
  return `<div class="panel"><h2>${esc(title)} (${events.length})</h2>${events.length
    ? `<div class="scroll"><table class="stack"><thead><tr><th>Event</th><th>Type</th><th>When</th><th>Status</th><th>Signed up</th><th></th></tr></thead>
      <tbody>${eventRows(events, base, canManage)}</tbody></table></div>`
    : `<div class="empty">${esc(empty)}</div>`}</div>`;
}

/** The Events page. */
export function eventsBody({ events, base, canManage, today }) {
  const by = (phase) => events.filter((e) => eventPhase(e, today) === phase);
  // Coming up soonest first; past newest first (the list arrives newest first).
  const coming = by('coming').reverse();
  return `<h1>Events</h1>
<p class="sub">Every evaluation, past and upcoming. Choose one to see its roster, notes and decisions.</p>
${canManage ? `<div class="evactions"><a class="btn" href="${esc(base)}/events/new">New event</a></div>` : ''}
${eventTable('Open for sign-ups', by('open'), base, canManage, 'Nothing is open for sign-ups right now.')}
${eventTable('Coming up', coming, base, canManage, 'Nothing scheduled.')}
${eventTable('Past', by('past'), base, canManage, 'No past events yet.')}`;
}

/** One event's page: its sessions and sign-ups, and the way into its roster. */
export function eventBody({ event, sessions, counts, base, canExport, isCurrent, manage = '', extra = '', invitations = '' }) {
  const rows = sessions.map((s) => `<tr>
    <td data-label="Session"><strong>${esc(s.session_time)}</strong></td>
    <td data-label="Signed up">${esc(s.taken)} of ${esc(s.capacity)}</td>
    <td data-label="Availability">${s.full ? '<span class="pill waitlist">full</span>' : `<span class="pill confirmed">${esc(s.remaining)} open</span>`}</td>
    <td data-label="Waiting">${esc(counts.waitingBySession[s.session_time] || 0)} waiting</td>
  </tr>`).join('');
  const where = event.location ? ` · ${event.location}` : '';
  return `${backButton(`${base}/events`, 'All events')}
<h1>${esc(event.name)}</h1>
<p class="sub">${esc(KIND[event.kind] || event.kind)} · ${esc(whenLine(event))}${esc(where)} · ${esc(STATUS[event.status] || event.status)}${
  isCurrent ? ' · the current evaluation (the default for Roster and the website\'s evaluation form)' : ''}</p>
${manage}
<div class="cards">
  <div class="card"><div class="n">${esc(counts.confirmed)}</div><div class="l">Signed up</div></div>
  <div class="card"><div class="n">${esc(counts.waitlist)}</div><div class="l">Waiting list</div></div>
  <div class="card"><div class="n">${esc(counts.cancelled)}</div><div class="l">Cancelled</div></div>
</div>
<div class="evactions">
  ${viewForm(base, event.id, '/', 'Roster')}
  ${event.kind === 'evaluation' ? `${viewForm(base, event.id, '/eval', 'Evaluations')}${viewForm(base, event.id, '/decisions', 'Decisions')}` : ''}
  ${canExport ? `<a class="btn" href="${esc(base)}/events/${esc(event.id)}/registrations.csv">Download sign-ups (CSV)</a>` : ''}
  <a class="btn" href="${esc(base)}/programs/${esc(event.id)}">Settings</a>
</div>
<div class="panel"><h2>Sessions</h2>${sessions.length
  ? `<div class="scroll"><table class="stack"><thead><tr><th>Session</th><th>Signed up</th><th>Availability</th><th>Waiting</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
  : '<div class="empty">No sessions yet. Add them in Settings.</div>'}</div>
${extra}
${invitations}`;
}

/**
 * The picker at the top of Roster, Evaluations and Decisions, and a plain
 * notice when the event shown isn't the default one.
 */
export function eventBar({ base, env, events, returnTo }) {
  const defaultId = events.find((e) => e.is_current)?.id ?? (env.BASE_EVENT_ID ?? env.EVENT_ID);
  const options = events.map((e) => `<option value="${esc(e.id)}"${e.id === env.EVENT_ID ? ' selected' : ''}>${
    esc(e.name)}${e.first_day ? ` (${esc(whenLine(e))})` : ''}${e.id === defaultId ? ' — current' : ''}</option>`).join('');
  const other = env.EVENT_ID !== defaultId;
  return `<form class="eventbar" method="post" action="${esc(base)}/events/view">
  <label for="event-pick">Event</label>
  <select id="event-pick" name="event">${options}</select>
  <input type="hidden" name="return" value="${esc(returnTo)}">
  <button type="submit">Show</button>
</form>
${other ? `<div class="notice" role="note">You're looking at <strong>${esc(env.EVENT_LABEL || env.EVENT_ID)}</strong>, not the current
evaluation. Notes and decisions you save here are for this event.
<form method="post" action="${esc(base)}/events/view" style="display:inline">
  <input type="hidden" name="event" value=""><input type="hidden" name="return" value="${esc(returnTo)}">
  <button type="submit">Back to the current evaluation</button></form></div>` : ''}`;
}

// --- creating and running events (EV2) ------------------------------------------------

const GRADE_NAMES = ['K', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];
const MAX_SESSION_ROWS = 6;

export const EVENT_FORM_STYLES = `
  .evform fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px 6px; margin: 0 0 16px; background: #fff; }
  .evform legend { font-weight: 700; padding: 0 6px; }
  .evform .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .evform .f { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; flex: 1 1 200px; font-size: 14px; }
  .evform .f.small { flex: 0 1 120px; }
  .evform label { font-weight: 700; }
  .evform .hint { color: var(--muted); font-size: 12px; font-weight: 400; }
  .evform input, .evform select, .evform textarea { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; min-height: 40px; }
  .evform textarea { min-height: 90px; }
  .evform .check { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; }
  .evform .err { color: var(--danger); font-size: 13px; font-weight: 700; }
  .kinds { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin: 0 0 16px; }
  .kinds label { display: block; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: #fff; cursor: pointer; font-weight: 400; }
  .kinds label strong { display: block; font-size: 15px; }
  .kinds input { margin-right: 6px; }
  .preview { border: 1px dashed var(--line); border-radius: 10px; padding: 14px; background: #fff; margin-bottom: 22px; }
  .pv-banner { background: var(--navy); color: #fff; border-radius: 8px; padding: 12px 16px; display: flex; gap: 12px;
    align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 14px; }
  .pv-banner .t { font-weight: 800; }
  .pv-banner .s { font-size: 13px; opacity: .9; }
  .pv-cta { background: var(--gold); color: var(--navy); border-radius: 999px; padding: 6px 14px; font-weight: 800; font-size: 13px; }
  .pv-card { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; max-width: 420px; }
  .pv-card .k { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; }
  .pv-card h3 { margin: 4px 0 6px; font-size: 18px; }
  .pv-card p { margin: 4px 0; font-size: 14px; }
`;

/** Step 1: what kind of event, and where it starts from. */
export function newEventChooser({ base, events }) {
  const kinds = [
    ['evaluation', 'Evaluation', 'Time slots, a cap and a waiting list.'],
    ['open_gym', 'Open gym', 'A shoot-around on one date. Repeat it weekly after.'],
    ['camp', 'Camp', 'One or more days; a price paid at check-in for now.'],
    ['scrimmage', 'Scrimmage', 'People register interest; you confirm them.'],
    ['tournament', 'Tournament', 'Teams enter (one we host) or our players register interest.'],
  ];
  const from = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}${e.first_day ? ` (${esc(whenLine(e))})` : ''}</option>`).join('');
  return `${backButton(`${base}/events`, 'All events')}
<h1>New event</h1>
<p class="sub">Choose the kind. The form starts from the last one of that kind, so usually you just change the date.</p>
<form class="evform" method="get" action="${esc(base)}/events/new/form">
  <fieldset><legend>Kind of event</legend>
    <div class="kinds">${kinds.map(([k, label, hint], i) => `<label><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}>
      <strong>${esc(label)}</strong><span class="hint">${esc(hint)}</span></label>`).join('')}</div>
  </fieldset>
  <fieldset><legend>Start from</legend>
    <div class="f"><label for="from">Copy</label>
      <select id="from" name="from"><option value="last" selected>The last event of this kind</option>
        <option value="">Nothing (a fresh form)</option>${from}</select></div>
  </fieldset>
  <button class="bigbtn" type="submit">Next</button>
</form>`;
}

function field(id, label, input, { hint = '', err = '', cls = '' } = {}) {
  return `<div class="f${cls ? ` ${cls}` : ''}"><label for="${id}">${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</label>
  ${input}${err ? `<span class="err" id="${id}-err">${esc(err)}</span>` : ''}</div>`;
}
const attrs = (id, err) => `id="${id}" name="${id}"${err ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}`;
const gradeSelect = (id, value, err) => `<select ${attrs(id, err)}><option value="">—</option>${GRADE_NAMES
  .map((g, i) => `<option value="${i}"${value !== null && value !== undefined && value !== '' && Number(value) === i ? ' selected' : ''}>${g}</option>`).join('')}</select>`;

/** Step 2: the event's details, prefilled. */
export function eventFormBody({ base, v, errors = {}, waivers, kindLabel, multiDay }) {
  const e = (k) => errors[k] || '';
  const sessions = [];
  for (let i = 1; i <= MAX_SESSION_ROWS; i += 1) {
    const s = v.sessions[i - 1] || {};
    sessions.push(`<div class="row">
      ${field(`s${i}_name`, i === 1 ? 'Session' : `Session ${i}`, `<input ${attrs(`s${i}_name`, e(`s${i}`))} value="${esc(s.name || '')}" maxlength="60">`,
        { hint: i === 1 ? 'e.g. 9:00 AM, or 4th grade for a tournament division' : '', err: e(`s${i}`) })}
      ${field(`s${i}_start`, 'Starts', `<input type="time" ${attrs(`s${i}_start`)} value="${esc(s.start || '')}">`, { cls: 'small' })}
      ${field(`s${i}_end`, 'Ends', `<input type="time" ${attrs(`s${i}_end`)} value="${esc(s.end || '')}">`, { cls: 'small' })}
      ${field(`s${i}_cap`, v.mode === 'team' ? 'Teams' : 'How many', `<input type="number" min="1" max="500" ${attrs(`s${i}_cap`)} value="${esc(s.cap ?? '')}">`, { cls: 'small' })}
    </div>`);
  }
  const errorList = Object.values(errors);
  return `${backButton(`${base}/events/new`, 'Choose another kind')}
<h1>New ${esc(kindLabel.toLowerCase())}</h1>
<p class="sub">${v.from ? 'Copied from an earlier event. Check the date and anything that changed, then save.' : 'Fill in the details, then save.'}
It is saved as a hidden draft; you preview and publish it next.</p>
${errorList.length ? `<div class="notice" role="alert"><strong>Please fix:</strong><ul>${errorList.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
<form class="evform" method="post" action="${esc(base)}/events/new" novalidate>
  <input type="hidden" name="kind" value="${esc(v.kind)}"><input type="hidden" name="from" value="${esc(v.from || '')}">
  <fieldset><legend>The event</legend>
    ${field('name', 'Name', `<input ${attrs('name', e('name'))} value="${esc(v.name)}" maxlength="120" required>`, { err: e('name') })}
    ${v.kind === 'tournament' ? `<fieldset><legend>Who signs up</legend>
      <label class="check"><input type="radio" name="mode" value="team"${v.mode !== 'interest' ? ' checked' : ''}> Teams enter (a tournament we host)</label>
      <label class="check"><input type="radio" name="mode" value="interest"${v.mode === 'interest' ? ' checked' : ''}> Our players register interest (one we enter)</label></fieldset>` : ''}
    <div class="row">
      ${field('starts_on', multiDay ? 'First day' : 'Date', `<input type="date" ${attrs('starts_on', e('starts_on'))} value="${esc(v.starts_on)}" required>`, { err: e('starts_on') })}
      ${multiDay ? field('ends_on', 'Last day', `<input type="date" ${attrs('ends_on', e('ends_on'))} value="${esc(v.ends_on)}">`, { hint: 'if more than one day', err: e('ends_on') }) : ''}
    </div>
    ${field('location', 'Where', `<input ${attrs('location', e('location'))} value="${esc(v.location)}" maxlength="160" required>`,
      { hint: 'the full address, so the map link works', err: e('location') })}
    <div class="row">
      ${field('grade_min', 'Youngest grade', gradeSelect('grade_min', v.grade_min, e('grades')), { cls: 'small', err: e('grades') })}
      ${field('grade_max', 'Oldest grade', gradeSelect('grade_max', v.grade_max, e('grades')), { cls: 'small' })}
    </div>
  </fieldset>
  <fieldset><legend>${v.mode === 'team' ? 'Divisions' : 'Sessions'}</legend>
    ${errors.sessions ? `<p class="err">${esc(errors.sessions)}</p>` : ''}
    ${sessions.join('')}
  </fieldset>
  <fieldset><legend>Sign-ups</legend>
    <div class="row">
      ${field('opens', 'Open', `<input type="datetime-local" ${attrs('opens', e('opens'))} value="${esc(v.opens)}">`, { hint: 'Central; blank = when you publish', err: e('opens') })}
      ${field('closes', 'Close', `<input type="datetime-local" ${attrs('closes', e('closes'))} value="${esc(v.closes)}">`, { hint: 'Central; blank = 11:59 PM the day before', err: e('closes') })}
    </div>
    <div class="row">
      ${field('price', 'Price', `<input ${attrs('price', e('price'))} value="${esc(v.price)}" inputmode="decimal" placeholder="Free">`,
        { hint: 'blank = free', err: e('price'), cls: 'small' })}
      ${field('payment', 'If there is a price', `<select ${attrs('payment')}>
        <option value="at_check_in"${v.payment !== 'online' ? ' selected' : ''}>Paid at check-in</option>
        <option value="online"${v.payment === 'online' ? ' selected' : ''}>Paid online when they sign up (needs Stripe)</option></select>`)}
      ${field('waiver_version_id', 'Waiver', `<select ${attrs('waiver_version_id', e('waiver'))}><option value="">Choose one before publishing</option>${waivers
        .map((w) => `<option value="${esc(w.id)}"${w.id === v.waiver_version_id ? ' selected' : ''}>${esc(w.title)} (${esc(w.id)})</option>`).join('')}</select>`,
        { err: e('waiver') })}
    </div>
    ${v.mode === 'spot' ? `<label class="check f"><input type="checkbox" name="waitlist" value="1"${v.waitlist ? ' checked' : ''}> Keep a waiting list when a session fills</label>` : ''}
    <label class="check f"><input type="checkbox" name="notify" value="1"${v.notify ? ' checked' : ''}> Email staff on every sign-up (otherwise it's in the daily brief)</label>
  </fieldset>
  <fieldset><legend>On the website</legend>
    ${field('description', 'Description', `<textarea ${attrs('description', e('description'))} maxlength="800">${esc(v.description)}</textarea>`,
      { hint: 'what families read on the event card', err: e('description') })}
    ${field('banner_title', 'Banner title', `<input ${attrs('banner_title')} value="${esc(v.banner_title)}" maxlength="80">`, { hint: 'blank = the name' })}
    ${field('banner_text', 'Banner line', `<input ${attrs('banner_text')} value="${esc(v.banner_text)}" maxlength="160">`, { hint: 'blank = date · time · town · sign up by' })}
    ${field('share_text', 'Share wording', `<input ${attrs('share_text')} value="${esc(v.share_text)}" maxlength="280">`, { hint: 'blank = written for you' })}
  </fieldset>
  <button class="bigbtn" type="submit">Save as draft</button>
</form>`;
}

/** The banner and card exactly as the website will show them. */
export function previewBlock(m) {
  return `<div class="preview" aria-label="Website preview">
  <p class="sub" style="margin:0 0 10px">How it looks on tnsaints.com${m.featured ? ' (in the banner, because it is featured)' : ''}:</p>
  ${m.featured ? `<div class="pv-banner"><div><div class="t">${esc(m.banner.title)}</div><div class="s">${esc(m.banner.text)}</div></div>
    <span class="pv-cta">${esc(m.cta)}</span></div>` : ''}
  <div class="pv-card"><div class="k">${esc(m.kind_label)}</div><h3>${esc(m.name)}</h3>
    <p><strong>${esc([m.date_line, m.time_line].filter(Boolean).join(' · '))}</strong></p>
    ${m.location ? `<p>${esc(m.location)}</p>` : ''}
    <p>${esc([m.grade_line, m.price_line].filter(Boolean).join(' · '))}</p>
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}
    ${m.sessions.length > 1 ? `<p>${m.sessions.map((s) => esc(s.time ? `${s.name} (${s.time})` : s.name)).join(' · ')}</p>` : ''}
    ${m.closes_line ? `<p class="sub" style="margin:6px 0 0">${esc(m.closes_line)}</p>` : ''}
    <p style="margin-top:10px"><span class="pv-cta">${esc(m.cta)}</span></p>
  </div>
  <p class="sub" style="margin:10px 0 0">Share wording: ${esc(m.share_text)}</p>
</div>`;
}

const ACTION_MESSAGES = {
  created: 'Saved as a hidden draft. Check the preview, then publish.',
  published: 'Published: it is open for sign-ups and listed on the website.',
  'needs-waiver': 'Choose a waiver first (Settings, then Waiver).',
  'needs-session': 'Add at least one session first (Settings, then Groups).',
  'needs-stripe': 'This event is paid online, which needs Stripe set up and switched on first (Admin, then Billing). Or choose "Paid at check-in".',
  'publish-refused': "It couldn't open: check it has a price if it isn't free, and a waiver (Settings).",
  closed: 'Closed: sign-ups have stopped.',
  archived: 'Archived: it no longer appears in lists.',
  featured: 'Featured: it is the one in the website banner.',
  unfeatured: 'No event is in the website banner now.',
  repeated: 'The next weeks are made, each a week later, in the same state as this one. They are listed under Events.',
  invalid: 'That did not work. Check and try again.',
  'interest-confirmed': 'Confirmed.',
  'interest-declined': 'Declined.',
  'team-withdrawn': 'Team withdrawn. If a team was waiting for that division, it has the place now.',
};

/** The controls on an event's page, for staff who manage events. */
export function eventManagePanel({ base, event, model, featured, msg }) {
  const post = (action, label) => `<form method="post" action="${esc(base)}/events/${esc(event.id)}/${action}">
    <button type="submit">${esc(label)}</button></form>`;
  const isOpen = event.status === 'open';
  return `${msg && ACTION_MESSAGES[msg] ? `<div class="notice" role="status">${esc(ACTION_MESSAGES[msg])}</div>` : ''}
<div class="evactions">
  ${isOpen ? post('close', 'Close sign-ups') : post('publish', event.status === 'closed' ? 'Reopen' : 'Publish')}
  ${featured ? post('unfeature', 'Take out of the banner') : post('feature', 'Put in the website banner')}
  <a class="btn" href="${esc(base)}/events/new/form?kind=${esc(event.kind)}&amp;from=${esc(event.id)}">Duplicate</a>
  ${event.kind === 'open_gym' ? `<form method="post" action="${esc(base)}/events/${esc(event.id)}/repeat" class="evactions" style="margin:0">
    <label for="weeks" class="sub" style="align-self:center;margin:0">Repeat weekly for</label>
    <select id="weeks" name="weeks">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${i === 3 ? ' selected' : ''}>${i + 1} week${i ? 's' : ''}</option>`).join('')}</select>
    <button type="submit">Make them</button></form>` : ''}
  ${event.status !== 'archived' ? post('archive', 'Archive') : ''}
</div>
${previewBlock({ ...model, featured })}`;
}

// --- interest and team entries (EV3) --------------------------------------------------

const INTEREST_STATUS = { interested: 'Interested', confirmed: 'Confirmed', declined: 'Declined', withdrawn: 'Withdrew' };
const TEAM_STATUS = { entered: 'Entered', waitlist: 'Waiting list', withdrawn: 'Withdrew' };

/** Who registered interest, and the way to confirm or decline them. */
export function interestPanel({ base, eventId, rows, emails }) {
  const act = (r, action, label) => `<form method="post" action="${esc(base)}/events/${esc(eventId)}/interest/${esc(r.id)}/${action}"
    style="display:inline"><button type="submit">${esc(label)}</button></form>`;
  const body = rows.map((r) => `<tr>
    <td data-label="Player"><strong>${esc(r.player_name)}</strong></td>
    <td data-label="Grade">${esc(r.grade)}</td>
    <td data-label="Parent">${esc(r.parent_name)}<br><a href="mailto:${esc(r.parent_email)}">${esc(r.parent_email)}</a> · ${esc(r.phone)}</td>
    <td data-label="Note">${esc(r.notes || '')}</td>
    <td data-label="Status"><span class="pill ${r.status === 'confirmed' ? 'confirmed' : r.status === 'interested' ? 'waitlist' : 'cancelled'}">${esc(INTEREST_STATUS[r.status] || r.status)}</span></td>
    <td data-label="">${r.status === 'withdrawn' ? '' : `${r.status !== 'confirmed' ? act(r, 'confirm', 'Confirm') : ''} ${r.status !== 'declined' ? act(r, 'decline', 'Decline') : ''}`}</td>
  </tr>`).join('');
  return `<div class="panel"><h2>Interest (${rows.filter((r) => r.status !== 'withdrawn').length})</h2>
${rows.length ? `<div class="scroll"><table class="stack"><thead><tr><th>Player</th><th>Grade</th><th>Parent</th><th>Note</th><th>Status</th><th></th></tr></thead>
<tbody>${body}</tbody></table></div>` : '<div class="empty">Nobody has registered interest yet.</div>'}
<p class="sub" style="padding:0 16px 12px;margin:0">${emails
  ? 'Confirming emails the family that they have a place.'
  : 'Confirming records it here. No email is sent: event emails are switched off (EVENT_EMAILS_ENABLED).'}</p></div>`;
}

/** The teams entered, by division, and the way to withdraw one. */
export function teamsPanel({ base, eventId, rows }) {
  const body = rows.map((r) => `<tr>
    <td data-label="Team"><strong>${esc(r.team_name)}</strong></td>
    <td data-label="Division">${esc(r.division)}</td>
    <td data-label="Coach">${esc(r.coach_name)}<br><a href="mailto:${esc(r.coach_email)}">${esc(r.coach_email)}</a> · ${esc(r.coach_phone)}</td>
    <td data-label="Players">${esc(r.players_count)}</td>
    <td data-label="Status"><span class="pill ${r.status === 'entered' ? 'confirmed' : r.status === 'waitlist' ? 'waitlist' : 'cancelled'}">${esc(TEAM_STATUS[r.status] || r.status)}</span></td>
    <td data-label="">${r.status === 'withdrawn' ? '' : `<form method="post" action="${esc(base)}/events/${esc(eventId)}/teams/${esc(r.id)}/withdraw"
      style="display:inline"><button type="submit">Withdraw</button></form>`}</td>
  </tr>`).join('');
  return `<div class="panel"><h2>Teams (${rows.filter((r) => r.status === 'entered').length} entered)</h2>
${rows.length ? `<div class="scroll"><table class="stack"><thead><tr><th>Team</th><th>Division</th><th>Coach</th><th>Players</th><th>Status</th><th></th></tr></thead>
<tbody>${body}</tbody></table></div>` : '<div class="empty">No teams entered yet.</div>'}</div>`;
}

// --- invitations (EV5) -----------------------------------------------------------------

const SOURCE_LABEL = { events: 'Earlier events', academy: 'Academy families', teams: 'Team families', crm: 'CRM contacts' };
const CAMPAIGN_STATUS = { draft: 'Draft — waiting for approval', approved: 'Approved', cancelled: 'Cancelled' };

/** The invitations already made for an event, and the way to make one. */
export function invitationsPanel({ base, eventId, campaigns }) {
  return `<div class="panel"><h2>Invitations</h2><div style="padding:12px 16px;font-size:14px">
${campaigns.length ? `<ul style="margin:0 0 10px;padding-left:18px">${campaigns.map((c) => `<li><a href="${esc(base)}/events/${esc(eventId)}/invites/${esc(c.id)}">${esc(c.subject)}</a>
  · ${esc(CAMPAIGN_STATUS[c.status] || c.status)} · ${esc(c.total)} people · ${esc(c.sent)} sent · ${esc(c.registered)} signed up</li>`).join('')}</ul>`
    : '<p style="margin:0 0 10px">Nobody has been invited yet.</p>'}
<a class="btn" href="${esc(base)}/events/${esc(eventId)}/invite">Invite people</a>
</div></div>`;
}

const checkbox = (name, value, label, checked) => `<label class="check f"><input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}> ${esc(label)}</label>`;

/** Who to invite (a GET form that counts) and what to say (a POST that saves a draft). */
export function invitePageBody({ base, event, options, audience, result, values = {}, errors = [], defaults }) {
  const hidden = [
    ...audience.events.map((v) => ['from_event', v]), ...(audience.academy ? [['academy', '1']] : []),
    ...audience.teams.map((v) => ['team', v]), ...audience.crmKinds.map((v) => ['crm_kind', v]),
    ...(audience.crmStage ? [['crm_stage', audience.crmStage]] : []),
  ].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const total = result ? result.people.length : 0;
  return `${backButton(`${base}/events/${event.id}`, event.name)}
<h1>Invite people to ${esc(event.name)}</h1>
<p class="sub">Choose who, check the count, then write the invitation. It is saved as a draft: nothing is sent until it is approved.</p>
<form class="evform" method="get" action="${esc(base)}/events/${esc(event.id)}/invite">
  <fieldset><legend>Who</legend>
    ${options.events.length ? `<p class="hint" style="margin:0 0 6px">People who signed up for:</p>${options.events
      .map((e) => checkbox('from_event', e.id, `${e.name} (${e.signups})`, audience.events.includes(e.id))).join('')}` : ''}
    ${checkbox('academy', '1', 'Families with an academy place', audience.academy)}
    ${options.teams.map((t) => checkbox('team', t.id, `Families on ${t.name}`, audience.teams.includes(t.id))).join('')}
    <p class="hint" style="margin:8px 0 6px">CRM contacts of these kinds:</p>
    ${CONTACT_KIND_LABELS.map(([k, l]) => checkbox('crm_kind', k, l, audience.crmKinds.includes(k))).join('')}
    <div class="f"><label for="crm_stage">CRM contacts at this stage</label>
      <select id="crm_stage" name="crm_stage"><option value="">Any stage</option>${options.stages
        .map((s) => `<option value="${esc(`${s.pipeline}:${s.stage}`)}"${audience.crmStage === `${s.pipeline}:${s.stage}` ? ' selected' : ''}>${esc(`${s.pipeline}: ${s.label}`)}</option>`).join('')}</select></div>
    <p class="hint" style="margin:6px 0">Always left out: anyone marked do-not-contact, anyone who unsubscribed, anyone already invited to or signed up for this event.</p>
    <button type="submit">Count them</button>
  </fieldset>
</form>
${result ? `<div class="notice" role="status"><strong>${esc(total)} ${total === 1 ? 'person' : 'people'}</strong> to invite
  (${Object.entries(result.bySource).map(([k, n]) => `${esc(SOURCE_LABEL[k] || k)}: ${esc(n)}`).join(', ')}; ${esc(result.excluded)} left out).
  ${result.capped ? 'That is more than one invitation can hold, so it stops at 500.' : ''}</div>
${total ? `<form class="evform" method="post" action="${esc(base)}/events/${esc(event.id)}/invite">${hidden}
  ${errors.length ? `<div class="notice" role="alert"><ul>${errors.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
  <fieldset><legend>The invitation</legend>
    <div class="f"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="120" value="${esc(values.subject ?? defaults.subject)}"></div>
    <div class="f"><label for="message">Message <span class="hint">plain text; blank lines start a new paragraph</span></label>
      <textarea id="message" name="message" maxlength="1500" rows="8">${esc(values.message ?? defaults.message)}</textarea></div>
    <p class="hint">Under your message the email shows the event — date, time, place — with a Sign up button, then an unsubscribe link and the academy's mailing address.</p>
  </fieldset>
  <button class="bigbtn" type="submit">Save as a draft</button>
</form>` : ''}` : ''}`;
}
const CONTACT_KIND_LABELS = [['family', 'Families'], ['coach', 'Coaches'], ['volunteer', 'Volunteers'], ['sponsor', 'Sponsors'],
  ['donor', 'Donors'], ['other', 'Other']];

const INVITE_MESSAGES = {
  created: 'Saved as a draft. Read it below; nothing is sent until it is approved.',
  approved: 'Approved. It sends a few at a time, within the day\'s email allowance.',
  'needs-address': "It can't be approved yet: the academy's mailing address is required in every invitation's footer (MAILING_ADDRESS).",
  cancelled: 'Cancelled. Nothing more from it will be sent.',
  sent: 'Sent the next ones.',
  'not-approved': 'Nothing was sent: it has not been approved.',
  budget: "Nothing more can go today: the day's invitation allowance is used. The rest go tomorrow.",
  failed: "Those didn't go through. They are tried again later, up to three times.",
  'none-left': 'There is nothing waiting to be sent.',
  disabled: 'Nothing was sent: invitation sending is switched off (INVITES_ENABLED).',
  invalid: 'That did not work. Check and try again.',
};

/** One invitation run: its numbers, its words, and approve / send / cancel. */
export function campaignBody({ base, event, summary, estimate, msg, canApprove, canSend, canExport, invitesOn, mailingAddress }) {
  const c = summary.campaign;
  const n = summary.counts;
  const post = (action, label) => `<form method="post" action="${esc(base)}/events/${esc(event.id)}/invites/${esc(c.id)}/${action}">
    <button type="submit">${esc(label)}</button></form>`;
  return `${backButton(`${base}/events/${event.id}`, event.name)}
<h1>${esc(c.subject)}</h1>
<p class="sub">Invitation to ${esc(event.name)} · ${esc(CAMPAIGN_STATUS[c.status] || c.status)}${c.approved_by ? ` by ${esc(c.approved_by)}` : ''}</p>
${msg && INVITE_MESSAGES[msg] ? `<div class="notice" role="status">${esc(INVITE_MESSAGES[msg])}</div>` : ''}
<div class="cards">
  <div class="card"><div class="n">${esc(n.total)}</div><div class="l">People</div></div>
  <div class="card"><div class="n">${esc(n.sent)}</div><div class="l">Sent</div></div>
  <div class="card"><div class="n">${esc(n.queued + n.held)}</div><div class="l">Not sent yet</div></div>
  <div class="card"><div class="n">${esc(n.registered)}</div><div class="l">Signed up</div></div>
</div>
${c.status === 'draft' ? `<div class="notice">When approved: about ${esc(estimate.today)} today, the rest over the following days
  (${esc(estimate.perDay)} invitations a day at most, so sign-up receipts always have room).${invitesOn ? '' : ' Sending is switched off (INVITES_ENABLED), so approving queues them until it is on.'}
  ${mailingAddress ? '' : '<br><strong>Approval needs the academy\'s mailing address first (MAILING_ADDRESS).</strong>'}</div>` : ''}
<div class="evactions">
  ${c.status === 'draft' && canApprove ? post('approve', 'Approve and start sending') : ''}
  ${c.status === 'approved' && canSend && invitesOn && n.queued ? post('send', 'Send the next 10 now') : ''}
  ${c.status !== 'cancelled' && (n.held || n.queued) ? post('cancel', 'Cancel') : ''}
  ${canExport ? `<a class="btn" href="${esc(base)}/events/${esc(event.id)}/invites/${esc(c.id)}/addresses">Copy addresses for Outlook (BCC)</a>` : ''}
</div>
<div class="panel"><h2>What it says</h2><div style="padding:12px 16px;font-size:14px">
  <p><strong>Subject:</strong> ${esc(c.subject)}</p>
  <div style="white-space:pre-wrap;border-left:3px solid var(--line);padding-left:12px">${esc(c.message)}</div>
  <p class="hint">Then: the event (${esc([event.date_line, event.time_line, event.location].filter(Boolean).join(' · '))}) with a Sign up button,
  an unsubscribe link, and "Tennessee Saints Basketball Academy LLC${mailingAddress ? ` · ${esc(mailingAddress)}` : ''}".</p>
</div></div>
${n.failed ? `<div class="notice">${esc(n.failed)} could not be sent after three tries.</div>` : ''}`;
}

/** The addresses, ready to paste into an Outlook BCC, in pieces. */
export function addressesBody({ base, event, campaignId, chunks, count }) {
  return `${backButton(`${base}/events/${event.id}/invites/${campaignId}`, 'The invitation')}
<h1>Addresses for Outlook</h1>
<p class="sub">${esc(count)} addresses, separated by semicolons. Paste each box into the BCC line of one message (Outlook takes about 400 at a time).
Sending from Outlook isn't tracked here, and has no unsubscribe link: add one line asking people to reply if they'd rather not hear from us.</p>
${chunks.map((text, i) => `<div class="f evform"><label for="bcc${i}">Part ${i + 1}</label>
  <textarea id="bcc${i}" readonly rows="6" style="width:100%">${esc(text)}</textarea></div>`).join('')}`;
}
