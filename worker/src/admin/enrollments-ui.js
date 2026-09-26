/**
 * The enrollment queue: where staff turn applications into seats.
 *
 * No script on this page. Every decision is a plain form post that redirects
 * back here, so it works on a phone at the gym and needs no CSP exception.
 * The seat count shown is the one the offer itself re-checks atomically — the
 * page is a guide, the UPDATE is the authority.
 */

import { esc } from './ui.js';
import { currentGrade, gradeLabel } from '../lib/grades.js';

export const DECLINE_REASONS = [
  ['grade', 'Outside the grade range'],
  ['space', 'No space this season'],
  ['withdrew', 'Family withdrew'],
  ['other', 'Other'],
];

const MESSAGES = {
  offered: 'Seat offered. The family has been emailed.',
  'offered-no-email': "Seat offered, but the email didn't send (daily allowance or provider). Tell the family directly.",
  full: 'That group is full. Nothing was changed.',
  state: 'That request has already moved on. Nothing was changed.',
  waitlisted: 'Moved to the waiting list.',
  declined: 'Declined.',
};

export const ENROLLMENT_STYLES = `
  .seatbar { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  .seat { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; min-width:190px; }
  .seat .n { font-size:22px; font-weight:800; }
  .seat.full .n { color: var(--danger); }
  .acts { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .acts form { display:flex; gap:6px; align-items:center; margin:0; }
  .acts select, .acts button { font: inherit; font-size: 14px; padding: 6px 8px; min-height: 36px; }
  .demand li { margin-bottom: 4px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

function prefs(row, groupsById) {
  let ids = [];
  try { ids = JSON.parse(row.preferred_group_ids || '[]'); } catch { ids = []; }
  if (!ids.length) return 'Any group';
  return ids.map((id) => groupsById.get(Number(id))?.name || `#${id}`).join(', ');
}

export function enrollmentsBody({ program, groups, rows, message, base = '' }) {
  const groupsById = new Map(groups.map((g) => [Number(g.id), g]));
  const active = groups.filter((g) => g.status === 'active');

  const seats = active.length
    ? `<div class="seatbar">${active
        .map((g) => {
          const full = Number(g.taken) >= Number(g.capacity);
          return `<div class="seat${full ? ' full' : ''}"><div class="n">${esc(g.taken)} / ${esc(g.capacity)}</div>
  <div><strong>${esc(g.name)}</strong></div><div class="sub" style="margin:0">${esc(g.schedule_summary)}</div></div>`;
        })
        .join('')}</div>`
    : '<div class="notice">No groups yet. Add the season\'s groups (days, times, capacity) before offering seats.</div>';

  // Demand: who is waiting, by grade and by the groups they could make.
  const waiting = rows.filter((r) => r.status !== 'offered');
  const byGrade = new Map();
  const byGroup = new Map();
  for (const r of waiting) {
    const g = currentGrade(r.grade_level, r.grade_school_year);
    const key = g === null ? 'Unknown grade' : gradeLabel(g);
    byGrade.set(key, (byGrade.get(key) || 0) + 1);
    let ids = [];
    try { ids = JSON.parse(r.preferred_group_ids || '[]'); } catch { ids = []; }
    for (const id of ids.length ? ids : ['any']) {
      const name = id === 'any' ? 'Any group' : groupsById.get(Number(id))?.name || `#${id}`;
      byGroup.set(name, (byGroup.get(name) || 0) + 1);
    }
  }
  const demand = waiting.length
    ? `<div class="panel"><h2>Demand: ${waiting.length} waiting for a seat</h2><div style="padding:12px 16px" class="demand">
  <p style="margin:0 0 6px"><strong>By grade:</strong> ${[...byGrade].map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>
  <p style="margin:0"><strong>Could make:</strong> ${[...byGroup].map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>
</div></div>`
    : '';

  const groupOptions = active
    .map((g) => {
      const full = Number(g.taken) >= Number(g.capacity);
      return `<option value="${esc(g.id)}"${full ? ' disabled' : ''}>${esc(g.name)}${full ? ' (full)' : ''}</option>`;
    })
    .join('');
  const declineOptions = DECLINE_REASONS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');

  const table = rows.length
    ? `<div class="panel"><h2>Requests, in the order they joined the line</h2><div class="scroll"><table class="stack">
<thead><tr><th>Player</th><th>Grade</th><th>Family</th><th>Evaluated</th><th>In line since</th><th>Could make</th><th>Status</th><th>Decision</th></tr></thead>
<tbody>${rows
        .map((r) => {
          const g = currentGrade(r.grade_level, r.grade_school_year);
          const status = r.status === 'offered'
            ? `Offered ${esc(groupsById.get(Number(r.group_id))?.name || '')}, pay by ${esc(String(r.offer_expires_at).slice(0, 10))}`
            : r.status === 'waitlist' ? 'Waiting list' : 'New';
          const offer = r.status !== 'offered' && groupOptions
            ? `<form method="post" action="${esc(base)}/enrollments/${esc(r.id)}/offer"><label class="sr" for="g${esc(r.id)}">Group</label>
  <select id="g${esc(r.id)}" name="group_id" required>${groupOptions}</select><button type="submit">Offer seat</button></form>`
            : '';
          const wait = r.status !== 'waitlist'
            ? `<form method="post" action="${esc(base)}/enrollments/${esc(r.id)}/waitlist"><button type="submit">${r.status === 'offered' ? 'Withdraw offer' : 'Waiting list'}</button></form>`
            : '';
          const decline = `<form method="post" action="${esc(base)}/enrollments/${esc(r.id)}/decline"><label class="sr" for="d${esc(r.id)}">Reason</label>
  <select id="d${esc(r.id)}" name="reason">${declineOptions}</select><button type="submit">Decline</button></form>`;
          return `<tr>
  <td data-label="Player">${esc(r.child_name)}</td>
  <td data-label="Grade">${esc(g === null ? '' : gradeLabel(g))}</td>
  <td data-label="Family">${esc(r.family_name || '')}</td>
  <td data-label="Evaluated">${Number(r.evaluations) ? 'Yes' : 'No'}</td>
  <td data-label="In line since">${esc(String(r.waitlisted_at || r.applied_at).slice(0, 10))}</td>
  <td data-label="Could make">${esc(prefs(r, groupsById))}</td>
  <td data-label="Status">${status}</td>
  <td data-label="Admin"><div class="acts">${offer}${wait}${decline}</div></td>
</tr>`;
        })
        .join('')}</tbody></table></div></div>`
    : '<div class="empty">No requests waiting.</div>';

  const draft = program.status !== 'open'
    ? `<div class="notice">${esc(program.name)} is <strong>${esc(program.status)}</strong>, so families cannot apply yet.
It opens once its monthly price, groups and waiver are in place.</div>`
    : '';

  return `<h1>Enrollment requests</h1>
<p class="sub">${esc(program.name)}. Offer seats only in groups with room; the family then has until the pay-by date.</p>
${message && MESSAGES[message] ? `<div class="notice" role="status">${esc(MESSAGES[message])}</div>` : ''}
${draft}${seats}${demand}${table}`;
}
