/**
 * The board's pages. Plain forms, no script.
 */

import { esc } from './ui.js';
import {
  OFFICES, MEETING_KINDS, DOC_CATEGORIES, COMPLIANCE_CATEGORIES, ATTENDANCE, VOTES, hasQuorum, centralToday,
} from '../governance/board.js';

export const BOARD_STYLES = `
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin: 0 0 16px; }
  .tabs a { padding:6px 12px; border-radius:999px; font-size:14px; font-weight:700; color:var(--navy);
            text-decoration:none; border:1px solid var(--line); background:#fff; }
  .tabs a[aria-current="page"] { background:var(--navy); color:#fff; border-color:var(--navy); }
  .bform { display:grid; gap:10px; padding:12px 16px; }
  .bform label { font-weight:600; font-size:14px; display:block; margin-bottom:3px; }
  .bform input, .bform select, .bform textarea { font:inherit; font-size:14px; padding:6px 8px; min-height:36px;
            border:1px solid var(--line); border-radius:6px; width:100%; box-sizing:border-box; }
  .bform textarea { min-height:120px; }
  .bform button, .inline button { font:inherit; font-size:14px; padding:6px 12px; min-height:36px; border-radius:6px;
            border:1px solid var(--navy); background:var(--navy); color:#fff; cursor:pointer; }
  .inline { display:inline; }
  .inline button.light { background:#fff; color:var(--navy); }
  .err { color:var(--danger); font-size:13px; }
  .pre { white-space:pre-wrap; padding:12px 16px; font-size:14px; }
  .ok { color:var(--ok); font-weight:700; } .warn { color:var(--warn); font-weight:700; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  @media (min-width: 760px) { .bform.cols { grid-template-columns: 1fr 1fr; } .bform .wide { grid-column: 1 / -1; } }
`;

export const BOARD_MESSAGES = {
  added: 'Added.', ended: 'Term ended.', saved: 'Saved.', circulated: 'Minutes circulated for review.',
  approved: 'Minutes approved and locked.', locked: 'Approved minutes are locked. Record a correction at the next meeting.',
  attendance: 'Attendance recorded.', 'no-quorum': 'No quorum was present, so the motion cannot be decided.',
  carried: 'The motion carried.', failed: 'The motion failed.', decided: 'That motion was already decided.',
  withdrawn: 'Motion withdrawn.', tabled: 'Motion tabled.', cancelled: 'Meeting cancelled.',
  host: 'Documents must be links to SharePoint (or another allowed host).', signed: 'Disclosure signed. Thank you.',
  exists: 'You have already signed this year’s disclosure.', 'not-member': 'Only serving board members sign a disclosure.',
  done: 'Done.', invalid: 'That did not look right. Nothing was changed.',
  incomplete: 'Choose a vote for every voting member present (a recusal needs its reason). Nothing was recorded.',
};

const when = (v) => new Date(v).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short',
  day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const notice = (m) => (Object.hasOwn(BOARD_MESSAGES, String(m)) ? `<div class="notice" role="status">${esc(BOARD_MESSAGES[m])}</div>` : '');

export function boardTabs(current, base) {
  return `<nav class="tabs" aria-label="Board">${[
    ['home', '/board', 'Overview'], ['meetings', '/board/meetings', 'Meetings'], ['members', '/board/members', 'Members'],
    ['documents', '/board/documents', 'Documents'], ['compliance', '/board/compliance', 'Compliance'],
    ['disclosures', '/board/disclosures', 'Disclosures'],
  ].map(([k, href, l]) => `<a href="${esc(base + href)}"${k === current ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}

export function overviewBody({ members, meetings, actions, compliance, myDisclosure, base }) {
  const serving = members.filter((m) => m.serving);
  // The next five, soonest first (the list arrives newest first).
  const nowIso = new Date().toISOString();
  const upcoming = meetings.filter((m) => m.status === 'scheduled' && m.starts_at >= nowIso).reverse().slice(0, 5);
  const today = centralToday();
  const due = compliance.filter((c) => c.status === 'open').slice(0, 8);
  return `<h1>Board</h1>${boardTabs('home', base)}
<p class="sub">The board's records: who serves, meetings and minutes, decisions, documents and filing deadlines. No children's data is here.</p>
${myDisclosure === false ? `<div class="notice">You have not signed this year's conflict-of-interest disclosure. <a href="${esc(base)}/board/disclosures">Sign it</a>.</div>` : ''}
<div class="two" style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
<div class="panel"><h2>Serving (${serving.length})</h2><ul style="margin:0;padding:10px 30px">${serving
    .map((m) => `<li>${esc(m.name)} · ${esc(OFFICES[m.office])}${m.voting ? '' : ' (non-voting)'}</li>`).join('') || '<li>Nobody yet.</li>'}</ul></div>
<div class="panel"><h2>Coming up</h2><ul style="margin:0;padding:10px 30px">${upcoming
    .map((m) => `<li><a href="${esc(base)}/board/meetings/${esc(m.id)}">${esc(m.title)}</a> · ${esc(when(m.starts_at))}</li>`).join('') || '<li>No meetings scheduled.</li>'}</ul></div>
<div class="panel"><h2>Open action items (${actions.length})</h2><ul style="margin:0;padding:10px 30px">${actions.slice(0, 10)
    .map((a) => `<li>${esc(a.title)}${a.due_on ? ` · due ${esc(a.due_on)}` : ''}${a.due_on && a.due_on < today ? ' <span class="warn">overdue</span>' : ''}</li>`).join('') || '<li>None.</li>'}</ul></div>
<div class="panel"><h2>Filing deadlines</h2><ul style="margin:0;padding:10px 30px">${due
    .map((c) => `<li>${esc(c.title)} · ${c.due_on ? esc(c.due_on) : '<span class="warn">needs a date</span>'}${c.due_on && c.due_on < today ? ' <span class="warn">overdue</span>' : ''}</li>`).join('') || '<li>Nothing open.</li>'}</ul></div>
</div>`;
}

export function membersBody({ members, canManage, base, message, values = {}, errors = {} }) {
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}">${esc(errors[k])}</div>` : '');
  return `<h1>Board</h1>${boardTabs('members', base)}${notice(message)}
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Name</th><th>Office</th><th>Term</th><th>Voting</th><th></th></tr></thead>
<tbody>${members.map((m) => `<tr${m.serving || m.upcoming ? '' : ' style="opacity:.6"'}><td data-label="Name">${esc(m.name)}<div class="sub" style="margin:0">${esc(m.email)}</div></td>
  <td data-label="Office">${esc(OFFICES[m.office])}</td><td data-label="Term">${esc(m.term_start)} – ${esc(m.term_end || 'open')}${m.serving ? '' : m.upcoming ? ' (not started)' : ' (ended)'}</td>
  <td data-label="Voting">${m.voting ? 'Yes' : 'No'}</td>
  <td data-label="Admin">${canManage && (m.serving || m.upcoming) ? `<form class="inline" method="post" action="${esc(base)}/board/members/${esc(m.id)}/end"><button class="light" type="submit">${m.upcoming ? 'Withdraw' : 'End term'}</button></form>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5">No board members yet.</td></tr>'}</tbody></table></div></div>
${canManage ? `<div class="panel"><h2>Add a board member</h2>
<form class="bform cols" method="post" action="${esc(base)}/board/members" novalidate>
  ${Object.keys(errors).length ? '<div class="notice wide" role="alert">Please fix the highlighted fields.</div>' : ''}
  <div><label for="bm-name">Name (required)</label><input id="bm-name" name="name" maxlength="80" value="${esc(values.name || '')}">${err('name')}</div>
  <div><label for="bm-email">Sign-in email (required)</label><input id="bm-email" name="email" type="email" maxlength="254" value="${esc(values.email || '')}">${err('email')}</div>
  <div><label for="bm-office">Office (required)</label><select id="bm-office" name="office">${Object.entries(OFFICES)
    .map(([k, l]) => `<option value="${k}"${values.office === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${err('office')}</div>
  <div><label><input type="checkbox" name="voting" value="1"${values.voting === 0 ? '' : ' checked'}> Voting member</label></div>
  <div><label for="bm-start">Term starts (required)</label><input id="bm-start" name="term_start" type="date" value="${esc(values.termStart || '')}">${err('term_start')}</div>
  <div><label for="bm-end">Term ends</label><input id="bm-end" name="term_end" type="date" value="${esc(values.termEnd || '')}">${err('term_end')}</div>
  <div class="wide"><p class="sub" style="margin:0">They also need a staff login with the role "board" (Users) — that role sees the board pages and nothing about children.</p></div>
  <div class="wide"><button type="submit">Add</button></div>
</form></div>` : ''}`;
}

export function meetingsBody({ meetings, canRecord, base, message, values = {}, errors = {} }) {
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}">${esc(errors[k])}</div>` : '');
  return `<h1>Board</h1>${boardTabs('meetings', base)}${notice(message)}
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Meeting</th><th>When</th><th>Status</th><th>Minutes</th></tr></thead>
<tbody>${meetings.map((m) => `<tr><td data-label="Meeting"><a href="${esc(base)}/board/meetings/${esc(m.id)}">${esc(m.title)}</a></td>
  <td data-label="When">${esc(when(m.starts_at))}</td><td data-label="Status">${esc(m.status)}</td><td data-label="Minutes">${esc(m.minutes_status)}</td></tr>`).join('')
    || '<tr><td colspan="4">No meetings yet.</td></tr>'}</tbody></table></div></div>
${canRecord ? `<div class="panel"><h2>Schedule a meeting</h2><form class="bform cols" method="post" action="${esc(base)}/board/meetings" novalidate>
  <div><label for="mt-title">Title (required)</label><input id="mt-title" name="title" maxlength="120" value="${esc(values.title || '')}">${err('title')}</div>
  <div><label for="mt-kind">Kind</label><select id="mt-kind" name="kind">${Object.entries(MEETING_KINDS)
    .map(([k, l]) => `<option value="${k}"${values.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${err('kind')}</div>
  <div><label for="mt-start">Starts (Central, required)</label><input id="mt-start" name="starts_at" type="datetime-local">${err('starts_at')}</div>
  <div><label for="mt-loc">Where</label><input id="mt-loc" name="location" maxlength="120" value="${esc(values.location || '')}"></div>
  <div class="wide"><label for="mt-agenda">Agenda</label><textarea id="mt-agenda" name="agenda" maxlength="8000">${esc(values.agenda || '')}</textarea>${err('agenda')}</div>
  <div class="wide"><button type="submit">Schedule</button></div></form></div>` : ''}`;
}

export function meetingBody({ detail, canRecord, canManage, base, message }) {
  const { meeting: m, attendance, motions, actions, members } = detail;
  const M = `${base}/board/meetings/${m.id}`;
  const status = new Map(attendance.map((a) => [a.board_member_id, a.status]));
  const quorumKnown = m.quorum_present !== null && m.quorum_present !== undefined;
  const quorum = quorumKnown && hasQuorum(Number(m.voting_members), Number(m.quorum_present));
  const locked = m.minutes_status === 'approved';
  const present = attendance.filter((a) => ['present', 'remote'].includes(a.status) && a.voting);
  return `<p><a href="${esc(base)}/board/meetings">&larr; All meetings</a></p>
<h1>${esc(m.title)}</h1><p class="sub">${esc(MEETING_KINDS[m.kind])} · ${esc(when(m.starts_at))}${m.location ? ` · ${esc(m.location)}` : ''} · ${esc(m.status)}</p>
${notice(message)}
${m.agenda ? `<div class="panel"><h2>Agenda</h2><div class="pre">${esc(m.agenda)}</div></div>` : ''}
<div class="panel"><h2>Attendance and quorum</h2><div style="padding:12px 16px">
${quorumKnown ? `<p style="margin:0 0 8px">${esc(m.quorum_present)} of ${esc(m.voting_members)} voting members present:
  ${quorum ? '<span class="ok">quorum</span>' : '<span class="warn">no quorum</span>'}.
  <span class="sub">Quorum is a majority of the voting members serving, until the bylaws say otherwise.</span></p>` : '<p style="margin:0 0 8px">Not taken yet.</p>'}
${canRecord && m.status !== 'cancelled' ? `<form method="post" action="${esc(M)}/attendance"><table><tbody>${members.map((b) => `<tr><td>${esc(b.name)}${b.voting ? '' : ' (non-voting)'}</td>
  <td><label class="sr" for="att-${esc(b.id)}">Attendance for ${esc(b.name)}</label><select id="att-${esc(b.id)}" name="m${esc(b.id)}">${ATTENDANCE
    .map((s) => `<option value="${s}"${(status.get(b.id) || 'absent') === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
  <div class="inline"><button type="submit">Record attendance</button></div></form>` : attendance.map((a) => `<div>${esc(a.name)}: ${esc(a.status)}</div>`).join('')}
${canManage && m.status === 'scheduled' ? `<form class="inline" method="post" action="${esc(M)}/cancel"><button class="light" type="submit">Cancel the meeting</button></form>` : ''}
</div></div>
<div class="panel"><h2>Motions</h2>${motions.map((mo) => `<div style="padding:10px 16px;border-bottom:1px solid var(--line)">
  <strong>${esc(mo.title)}</strong> — <em>${esc(mo.status)}</em>${mo.moved_name ? ` · moved by ${esc(mo.moved_name)}` : ''}${mo.seconded_name ? `, seconded by ${esc(mo.seconded_name)}` : ''}
  ${mo.body ? `<div class="pre" style="padding:4px 0">${esc(mo.body)}</div>` : ''}
  ${mo.votes.length ? `<div>${mo.votes.map((v) => `${esc(v.name)}: ${esc(v.vote)}${v.vote === 'recused' ? ` (${esc(v.recusal_reason)})` : ''}`).join(' · ')}</div>` : ''}
  ${canRecord && mo.status === 'pending' ? `<form method="post" action="${esc(M)}/motions/${esc(mo.id)}/votes" style="margin-top:6px">
    ${present.map((p) => `<div><label for="v-${esc(mo.id)}-${esc(p.board_member_id)}">${esc(p.name)}</label>
      <select id="v-${esc(mo.id)}-${esc(p.board_member_id)}" name="v${esc(p.board_member_id)}" required><option value="">— choose —</option>${VOTES.map((v) => `<option value="${v}">${esc(v)}</option>`).join('')}</select>
      <label class="sr" for="r-${esc(mo.id)}-${esc(p.board_member_id)}">Reason for recusal</label>
      <input id="r-${esc(mo.id)}-${esc(p.board_member_id)}" name="r${esc(p.board_member_id)}" maxlength="300" placeholder="If recused: why"></div>`).join('') || '<p>Take attendance first.</p>'}
    <div class="inline"><button type="submit">Record the vote</button></div></form>
  <form class="inline" method="post" action="${esc(M)}/motions/${esc(mo.id)}/withdrawn"><button class="light" type="submit">Withdrawn</button></form>
  <form class="inline" method="post" action="${esc(M)}/motions/${esc(mo.id)}/tabled"><button class="light" type="submit">Tabled</button></form>` : ''}
</div>`).join('') || '<div class="empty">No motions.</div>'}
${canRecord && m.status !== 'cancelled' ? `<form class="bform cols" method="post" action="${esc(M)}/motions">
  <div class="wide"><label for="mo-title">New motion (required)</label><input id="mo-title" name="title" maxlength="160"></div>
  <div class="wide"><label for="mo-body">Text</label><textarea id="mo-body" name="body" maxlength="4000"></textarea></div>
  <div><label for="mo-moved">Moved by</label><select id="mo-moved" name="moved_by"><option value="">—</option>${members.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
  <div><label for="mo-second">Seconded by</label><select id="mo-second" name="seconded_by"><option value="">—</option>${members.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
  <div class="wide"><button type="submit">Add motion</button></div></form>` : ''}
<p class="sub" style="padding:0 16px 12px;margin:0">A motion carries when more vote yes than no (abstentions and recusals count neither way), with quorum present.
Votes are locked once it is decided.</p></div>
<div class="panel"><h2>Minutes — ${esc(m.minutes_status)}</h2>
${locked ? `<div class="pre">${esc(m.minutes)}</div><p class="sub" style="padding:0 16px 12px;margin:0">Approved ${esc(String(m.minutes_approved_at).slice(0, 10))} and locked.</p>`
    : canRecord ? `<form class="bform" method="post" action="${esc(M)}/minutes/save">
  <label for="mn">Minutes</label><textarea id="mn" name="minutes" maxlength="30000" style="min-height:220px">${esc(m.minutes || '')}</textarea>
  <div><button type="submit">Save draft</button></div></form>
  <div style="padding:0 16px 12px">${m.minutes_status === 'draft' ? `<form class="inline" method="post" action="${esc(M)}/minutes/circulate"><button type="submit">Circulate for review</button></form>` : ''}
  ${m.minutes_status === 'circulated' ? `<form class="inline" method="post" action="${esc(M)}/minutes/approve"><button type="submit">Approve and lock (after the board votes to approve)</button></form>` : ''}</div>`
      : `<div class="pre">${m.minutes ? esc(m.minutes) : 'Not written yet.'}</div>`}</div>
<div class="panel"><h2>Action items</h2><ul style="margin:0;padding:10px 30px">${actions.map((a) => `<li>${esc(a.title)}${a.owner_email ? ` · ${esc(a.owner_email)}` : ''}${a.due_on ? ` · due ${esc(a.due_on)}` : ''} · ${esc(a.status)}${canRecord && a.status === 'open'
    ? ` <form class="inline" method="post" action="${esc(base)}/board/actions/${esc(a.id)}/done"><input type="hidden" name="back" value="${esc(m.id)}"><button class="light" type="submit">Done</button></form>` : ''}</li>`).join('') || '<li>None.</li>'}</ul>
${canRecord ? `<form class="bform cols" method="post" action="${esc(M)}/actions">
  <div class="wide"><label for="ai-title">New action item</label><input id="ai-title" name="title" maxlength="160"></div>
  <div><label for="ai-owner">Owner's email</label><input id="ai-owner" name="owner_email" type="email" maxlength="254"></div>
  <div><label for="ai-due">Due</label><input id="ai-due" name="due_on" type="date"></div>
  <div class="wide"><button type="submit">Add</button></div></form>` : ''}</div>`;
}

export function documentsBody({ documents, canEdit, base, message }) {
  return `<h1>Board</h1>${boardTabs('documents', base)}${notice(message)}
<p class="sub">The register of board documents. The files stay in SharePoint; these are links.</p>
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Document</th><th>Kind</th><th>Effective</th><th></th></tr></thead>
<tbody>${documents.map((d) => `<tr><td data-label="Document"><a href="${esc(d.url)}" rel="noopener noreferrer" target="_blank">${esc(d.title)}</a>${d.notes ? `<div class="sub" style="margin:0">${esc(d.notes)}</div>` : ''}</td>
  <td data-label="Kind">${esc(DOC_CATEGORIES[d.category])}</td><td data-label="Effective">${esc(d.effective_on || '')}</td>
  <td data-label="Admin">${canEdit ? `<form class="inline" method="post" action="${esc(base)}/board/documents/${esc(d.id)}/archive"><button class="light" type="submit">Archive</button></form>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="4">No documents yet.</td></tr>'}</tbody></table></div></div>
${canEdit ? `<div class="panel"><h2>Add a document</h2><form class="bform cols" method="post" action="${esc(base)}/board/documents">
  <div><label for="dc-title">Title (required)</label><input id="dc-title" name="title" maxlength="160"></div>
  <div><label for="dc-cat">Kind</label><select id="dc-cat" name="category">${Object.entries(DOC_CATEGORIES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
  <div class="wide"><label for="dc-url">SharePoint link (required)</label><input id="dc-url" name="url" type="url" maxlength="2000"></div>
  <div><label for="dc-eff">Effective</label><input id="dc-eff" name="effective_on" type="date"></div>
  <div><label for="dc-notes">Notes</label><input id="dc-notes" name="notes" maxlength="500"></div>
  <div class="wide"><button type="submit">Add</button></div></form></div>` : ''}`;
}

export function complianceBody({ items, canManage, base, message }) {
  const today = centralToday();
  return `<h1>Board</h1>${boardTabs('compliance', base)}${notice(message)}
<p class="sub">Filing and renewal deadlines. Items marked "needs a date" are waiting for the accountant or the policy to confirm it;
the list began from planning research and should be checked with the accountant.</p>
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>What</th><th>Kind</th><th>Due</th><th>Repeats</th><th></th></tr></thead>
<tbody>${items.map((c) => `<tr${c.status === 'done' ? ' style="opacity:.6"' : ''}><td data-label="What">${esc(c.title)}${c.notes ? `<div class="sub" style="margin:0">${esc(c.notes)}</div>` : ''}</td>
  <td data-label="Kind">${esc(COMPLIANCE_CATEGORIES[c.category])}</td>
  <td data-label="Due">${c.status === 'done' ? `done ${esc(c.completed_on || '')}` : c.due_on ? `${esc(c.due_on)}${c.due_on < today ? ' <span class="warn">overdue</span>' : ''}` : '<span class="warn">needs a date</span>'}</td>
  <td data-label="Repeats">${esc(c.recurrence)}</td>
  <td data-label="Admin">${canManage && c.status === 'open' ? `<form class="inline" method="post" action="${esc(base)}/board/compliance/${esc(c.id)}/date">
    <label class="sr" for="cd-${esc(c.id)}">Due date</label><input id="cd-${esc(c.id)}" name="due_on" type="date" value="${esc(c.due_on || '')}"><button class="light" type="submit">Set date</button></form>
    <form class="inline" method="post" action="${esc(base)}/board/compliance/${esc(c.id)}/done"><button type="submit">Done</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
${canManage ? `<div class="panel"><h2>Add a deadline</h2><form class="bform cols" method="post" action="${esc(base)}/board/compliance">
  <div class="wide"><label for="cp-title">What (required)</label><input id="cp-title" name="title" maxlength="160"></div>
  <div><label for="cp-cat">Kind</label><select id="cp-cat" name="category">${Object.entries(COMPLIANCE_CATEGORIES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
  <div><label for="cp-due">Due</label><input id="cp-due" name="due_on" type="date"></div>
  <div><label for="cp-rec">Repeats</label><select id="cp-rec" name="recurrence"><option value="annual">yearly</option><option value="quarterly">quarterly</option><option value="monthly">monthly</option><option value="once">once</option></select></div>
  <div><label for="cp-owner">Owner's email</label><input id="cp-owner" name="owner_email" type="email" maxlength="254"></div>
  <div class="wide"><label for="cp-notes">Notes</label><input id="cp-notes" name="notes" maxlength="1000"></div>
  <div class="wide"><button type="submit">Add</button></div></form></div>` : ''}`;
}

export function disclosuresBody({ year, status, mine, isMember, canManage, base, message }) {
  return `<h1>Board</h1>${boardTabs('disclosures', base)}${notice(message)}
<p class="sub">Each board member discloses, every year, any interest that could conflict with the academy's — and recuses from votes it touches.</p>
${isMember ? (mine ? `<div class="notice">You signed your ${esc(year)} disclosure on ${esc(String(mine.signed_at).slice(0, 10))}${mine.has_conflicts ? ', declaring an interest' : ', declaring none'}.</div>`
    : `<div class="panel"><h2>Your ${esc(year)} disclosure</h2><form class="bform" method="post" action="${esc(base)}/board/disclosures">
  <fieldset><legend style="font-weight:600">Do you, or anyone close to you, have an interest that could conflict with the academy's? (required)</legend>
    <label><input type="radio" name="has_conflicts" value="0"> No</label> <label><input type="radio" name="has_conflicts" value="1"> Yes</label></fieldset>
  <div><label for="ds-details">If yes, describe it</label><textarea id="ds-details" name="details" maxlength="4000"></textarea></div>
  <div><label for="ds-sig">Type your full name to sign (required)</label><input id="ds-sig" name="signature" maxlength="80" autocomplete="name"></div>
  <div><button type="submit">Sign</button></div></form></div>`) : ''}
${canManage ? `<div class="panel"><h2>${esc(year)}: who has disclosed</h2><div class="scroll"><table class="stack"><thead><tr><th>Member</th><th>Disclosed</th><th>Interest declared</th></tr></thead>
<tbody>${status.map((s) => `<tr><td data-label="Member">${esc(s.name)} · ${esc(OFFICES[s.office])}</td>
  <td data-label="Disclosed">${s.signed_at ? esc(String(s.signed_at).slice(0, 10)) : '<span class="warn">Not yet</span>'}</td>
  <td data-label="Interest">${s.signed_at ? (s.has_conflicts ? esc(s.details) : 'None') : ''}</td></tr>`).join('') || '<tr><td colspan="3">No serving members.</td></tr>'}</tbody></table></div></div>` : ''}`;
}
