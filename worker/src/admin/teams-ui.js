/**
 * Teams: the list, and one team's roster, coaches, schedule and calendar link.
 */

import { esc } from './ui.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';
import { EVENT_KINDS } from '../programs/teams.js';

export const TEAM_STYLES = `
  .tform { display:grid; gap:10px; padding:12px 16px; }
  .tform label { font-weight:600; font-size:14px; display:block; margin-bottom:3px; }
  .tform input, .tform select, .tform textarea { font:inherit; font-size:14px; padding:6px 8px; min-height:36px;
            border:1px solid var(--line); border-radius:6px; width:100%; box-sizing:border-box; }
  .tform button, .inline button { font:inherit; font-size:14px; padding:6px 12px; min-height:36px; border-radius:6px;
            border:1px solid var(--navy); background:var(--navy); color:#fff; cursor:pointer; }
  .inline { display:inline; }
  .inline button.light { background:#fff; color:var(--navy); }
  .err { color:var(--danger); font-size:13px; }
  .feed { word-break: break-all; font-size:13px; }
  @media (min-width: 760px) { .tform.cols { grid-template-columns: 1fr 1fr; } .tform .wide { grid-column: 1 / -1; } }
`;

export const TEAM_MESSAGES = {
  assigned: 'Coach assigned.',
  removed: 'Coach removed from the team.',
  'not-staff': 'Only active coaches and admins on the staff list can coach a team. Add them on the Users page first.',
  'not-cleared': 'Not assigned: their clearances are not all current. Record them on the Clearances page first.',
  exists: 'They already coach this team.',
  invalid: 'That did not look right. Nothing was changed.',
  'event-added': 'Added to the schedule.',
  'event-cancelled': 'Cancelled. Calendars that subscribe to the feed will show it as cancelled.',
  rotated: 'The calendar link was replaced. The old link no longer works — send families the new one.',
};

const when = (v) => new Date(v).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short',
  day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function teamsListBody({ teams, base = '', canManage }) {
  const rows = teams.map((t) => `<tr>
  <td data-label="Player"><a href="${esc(base)}/teams/${esc(t.id)}">${esc(t.name)}</a><div class="sub" style="margin:0">${esc(t.program_name)}</div></td>
  <td data-label="Players">${esc(t.players)}</td>
  <td data-label="Coaches">${esc(t.coaches || 'None yet')}</td>
  <td data-label="Next">${t.next_event ? esc(when(t.next_event)) : '—'}</td></tr>`).join('');
  return `<h1>Teams</h1>
<p class="sub">${canManage ? 'Every team. Teams are the groups of a team program (Programs).' : 'The teams you coach.'}</p>
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Team</th><th>Players</th><th>Coaches</th><th>Next on the schedule</th></tr></thead>
<tbody>${rows || `<tr><td colspan="4">${canManage ? 'No teams yet.' : 'You are not assigned to a team yet.'}</td></tr>`}</tbody></table></div></div>`;
}

export function teamBody({ detail, base = '', canManage, canSeeFamilies, staffOptions = [], feedUrl, message, eventValues = {}, eventErrors = {} }) {
  const { team, roster, coaches, events } = detail;
  const T = `${base}/teams/${team.id}`;
  const msg = TEAM_MESSAGES[message];
  const err = (k) => (eventErrors[k] ? `<div class="err" id="e-${k}">${esc(eventErrors[k])}</div>` : '');
  const aria = (k) => (eventErrors[k] ? ` aria-invalid="true" aria-describedby="e-${k}"` : '');
  const upcoming = events.filter((e) => Date.parse(e.starts_at) >= Date.now() - 3 * 60 * 60 * 1000);
  return `<p><a href="${esc(base)}/teams">&larr; All teams</a></p>
<h1>${esc(team.name)}</h1><p class="sub">${esc(team.program_name)}${team.schedule_summary ? ` · ${esc(team.schedule_summary)}` : ''}</p>
${msg ? `<div class="notice" role="status">${esc(msg)}</div>` : ''}
<div class="panel"><h2>Roster (${roster.length})</h2><div class="scroll"><table class="stack">
<thead><tr><th>Player</th><th>Grade</th><th>Shirt</th><th>Medical</th>${canSeeFamilies ? '<th>Family</th>' : ''}</tr></thead>
<tbody>${roster.map((p) => {
    const g = currentGrade(p.grade_level, p.grade_school_year);
    return `<tr><td data-label="Player">${esc(p.display_name)}${p.status === 'past_due' ? ' <span class="pill waitlist">payment due</span>' : ''}</td>
  <td data-label="Grade">${esc(g === null ? '' : gradeLabel(g))}</td><td data-label="Shirt">${esc(p.shirt_size || '')}</td>
  <td data-label="Medical">${p.has_medical ? '<span class="med">Medical note</span>' : ''}</td>
  ${canSeeFamilies ? `<td data-label="Family"><a href="${esc(base)}/crm/families/${esc(p.household_id)}">${esc(p.family_name || 'Family')}</a></td>` : ''}</tr>`;
  }).join('') || '<tr><td colspan="5">No players placed yet.</td></tr>'}</tbody></table></div>
${canSeeFamilies ? '' : '<div class="notice" style="margin:12px">Medical notes and family contact details are with academy admins. Ask Jacob.</div>'}</div>
<div class="panel"><h2>Coaches</h2><div style="padding:12px 16px">
${coaches.map((c) => `<div>${esc(c.display_name || c.staff_email)} · ${c.role === 'head' ? 'Head coach' : 'Assistant'}${canManage
    ? ` <form class="inline" method="post" action="${esc(T)}/coaches/remove"><input type="hidden" name="email" value="${esc(c.staff_email)}">
      <button class="light" type="submit">Remove</button></form>` : ''}</div>`).join('') || '<p style="margin:0">No coaches yet.</p>'}
${canManage ? `<form class="tform" method="post" action="${esc(T)}/coaches" style="padding:12px 0 0">
  <div><label for="ce">Coach</label><select id="ce" name="email">${staffOptions.map((s) => `<option value="${esc(s.email)}">${esc(s.name)}${s.cleared ? '' : ' (not cleared)'}</option>`).join('')}</select></div>
  <div><label for="cr">Role</label><select id="cr" name="role"><option value="head">Head coach</option><option value="assistant" selected>Assistant</option></select></div>
  <div><button type="submit">Assign</button></div>
  <p class="sub" style="margin:0">Only staff whose background check and trainings are all current can be assigned.</p>
</form>` : ''}</div></div>
<div class="panel"><h2>Schedule</h2>${upcoming.length ? `<div class="scroll"><table class="stack"><thead><tr><th>When</th><th>What</th><th>Where</th><th></th></tr></thead>
<tbody>${upcoming.map((e) => `<tr${e.cancelled_at ? ' style="opacity:.6"' : ''}>
  <td data-label="When">${esc(when(e.starts_at))}</td>
  <td data-label="What">${esc(e.title || EVENT_KINDS[e.kind])}${e.opponent ? ` vs ${esc(e.opponent)}` : ''}${e.cancelled_at ? ' (cancelled)' : ''}</td>
  <td data-label="Where">${esc(e.location || '')}</td>
  <td data-label="Admin">${canManage && !e.cancelled_at ? `<form class="inline" method="post" action="${esc(T)}/events/${esc(e.id)}/cancel">
    <button class="light" type="submit">Cancel</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Nothing scheduled.</div>'}
${canManage ? `<form class="tform cols" method="post" action="${esc(T)}/events" novalidate>
  <div><label for="ek">What (required)</label><select id="ek" name="kind"${aria('kind')}>${Object.entries(EVENT_KINDS)
    .map(([k, l]) => `<option value="${k}"${eventValues.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${err('kind')}</div>
  <div><label for="eo">Opponent</label><input id="eo" name="opponent" maxlength="80" value="${esc(eventValues.opponent || '')}"></div>
  <div><label for="es">Starts (Central, required)</label><input id="es" name="starts_at" type="datetime-local" value="${esc(eventValues.starts_local || '')}"${aria('starts_at')}>${err('starts_at')}</div>
  <div><label for="ee">Ends (Central)</label><input id="ee" name="ends_at" type="datetime-local" value="${esc(eventValues.ends_local || '')}"${aria('ends_at')}>${err('ends_at')}</div>
  <div><label for="el">Where</label><input id="el" name="location" maxlength="120" value="${esc(eventValues.location || '')}"></div>
  <div><label for="et">Title (optional)</label><input id="et" name="title" maxlength="80" value="${esc(eventValues.title || '')}"${aria('title')}>${err('title')}</div>
  <div class="wide"><label for="en">Notes for families</label><textarea id="en" name="notes" maxlength="500">${esc(eventValues.notes || '')}</textarea>
    <div class="sub" style="margin:2px 0 0">Shown in the calendar feed. No children's names or medical details.</div></div>
  <div class="wide"><button type="submit">Add to the schedule</button></div>
</form>` : ''}</div>
<div class="panel"><h2>Calendar feed</h2><div style="padding:12px 16px">
<p style="margin:0 0 6px">Families on this team see this link on their family page. It works in Google, Apple and Outlook calendars, and shows the
schedule only — no children.</p>
<p class="feed"><a href="${esc(feedUrl)}">${esc(feedUrl)}</a></p>
${canManage ? `<form class="inline" method="post" action="${esc(T)}/calendar/rotate"><button class="light" type="submit">Replace the link</button></form>
<span class="sub">If it has been shared too widely. The old link stops working.</span>` : ''}
</div></div>`;
}
