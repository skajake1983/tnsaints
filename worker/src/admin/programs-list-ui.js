/**
 * Programs: the list, a new program, and each program's details panel.
 */

import { esc } from './ui.js';
import { isoToCentral, PROGRAM_KINDS } from '../programs/manage.js';

const KIND = { academy: 'Academy', camp: 'Camp', clinic: 'Clinic', tournament: 'Tournament', team: 'Team', evaluation: 'Evaluation' };
const BILLING = { subscription: 'Monthly (PayPal subscription)', one_time: 'One payment', free: 'Free' };
const MODE = { approval: 'Families apply; staff offer seats', self_serve: 'Families pick a group and pay' };

export function programsListBody({ programs, base = '', values = {}, errors = {}, message = '' }) {
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}" style="color:var(--danger);font-size:13px">${esc(errors[k])}</div>` : '');
  const aria = (k) => (errors[k] ? ` aria-invalid="true" aria-describedby="e-${k}"` : '');
  const rows = programs.map((p) => `<tr>
  <td data-label="Player"><a href="${esc(base)}/programs/${esc(p.id)}">${esc(p.name)}</a><div class="sub" style="margin:0">${esc(p.id)}</div></td>
  <td data-label="Kind">${esc(KIND[p.kind] || p.kind)}</td>
  <td data-label="Status">${esc(p.status)}${p.public ? '' : ' · hidden'}</td>
  <td data-label="Joining">${esc(MODE[p.enrollment_mode] || p.enrollment_mode)}</td>
  <td data-label="Payment">${esc(BILLING[p.billing] || p.billing)}</td>
  <td data-label="Places">${esc(p.enrolled)} placed · ${esc(p.waiting)} waiting · ${esc(p.groups)} groups</td>
  <td data-label="Queue"><a href="${esc(base)}/enrollments?program=${esc(p.id)}">Requests</a></td>
</tr>`).join('');
  return `<h1>Programs</h1>
<p class="sub">Everything families can sign up for. A new program starts as a draft; it opens once it has a price (unless free),
a waiver, and — for monthly billing — a PayPal plan.</p>
${message ? `<div class="notice" role="status">${esc(message)}</div>` : ''}
<div class="panel"><div class="scroll"><table class="stack">
<thead><tr><th>Program</th><th>Kind</th><th>Status</th><th>Joining</th><th>Payment</th><th>Places</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No programs yet.</td></tr>'}</tbody></table></div></div>
<div class="panel"><h2>New program</h2>
<form method="post" action="${esc(base)}/programs/new" style="padding:12px 16px;display:grid;gap:10px;max-width:520px" novalidate>
  ${Object.keys(errors).length ? '<div class="notice" role="alert">Please fix the highlighted fields.</div>' : ''}
  <div><label for="np-name" style="font-weight:600">Name (required)</label><br>
    <input id="np-name" name="name" maxlength="120" value="${esc(values.name || '')}" style="width:100%"${aria('name')}>${err('name')}</div>
  <div><label for="np-kind" style="font-weight:600">Kind (required)</label><br>
    <select id="np-kind" name="kind"${aria('kind')}>${PROGRAM_KINDS.filter((k) => k !== 'academy')
    .map((k) => `<option value="${k}"${values.kind === k ? ' selected' : ''}>${esc(KIND[k])}</option>`).join('')}</select>${err('kind')}</div>
  <div><label for="np-billing" style="font-weight:600">How it is paid for (required)</label><br>
    <select id="np-billing" name="billing"${aria('billing')}>${Object.entries(BILLING)
    .map(([k, l]) => `<option value="${k}"${(values.billing || 'one_time') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <div class="sub" style="margin:2px 0 0">Evaluations are always free.</div>${err('billing')}</div>
  <div><label for="np-id" style="font-weight:600">Short id (required)</label><br>
    <input id="np-id" name="id" maxlength="40" value="${esc(values.id || '')}" pattern="[a-z0-9-]{3,40}"${aria('id')}>
    <div class="sub" style="margin:2px 0 0">Lowercase, like <code>summer-camp-2027</code>. It appears in links and cannot change.</div>${err('id')}</div>
  <div><button type="submit">Create draft</button></div>
</form></div>`;
}

/** The program page's "About this program" panel. */
/**
 * While an evaluation's sign-up is open and it has a preview image, links to
 * tnsaints.com shared on social media show this card (the website's
 * eval-preview Action reads it from /api/programs).
 */
function previewFields(program) {
  return `<fieldset style="border:1px solid #d9dee8;border-radius:8px;padding:8px 12px;display:grid;gap:8px">
    <legend style="font-weight:600;padding:0 4px">Link preview while sign-up is open</legend>
    <div class="sub" style="margin:0">When someone shares tnsaints.com, this card shows instead of the usual one until
      sign-up closes. Put the image on the website first; a new file name makes Facebook fetch it again.</div>
    <div><label for="pd-ptitle" style="font-weight:600">Preview title</label> <span class="sub">(optional)</span><br>
      <input id="pd-ptitle" name="preview_title" maxlength="120" value="${esc(program.preview_title || '')}" style="width:100%"></div>
    <div><label for="pd-pimage" style="font-weight:600">Preview image address</label>
      <span class="sub" id="pd-pimage-hint">(optional; must start https://tnsaints.com/)</span><br>
      <input id="pd-pimage" name="preview_image" type="url" maxlength="300" aria-describedby="pd-pimage-hint"
        placeholder="https://tnsaints.com/social-card-spring.jpg" value="${esc(program.preview_image || '')}" style="width:100%"></div>
  </fieldset>`;
}

export function detailsPanel({ program, base = '' }) {
  const academy = program.kind === 'academy';
  return `<div class="panel"><h2>About this program</h2>
<form method="post" action="${esc(base)}/programs/${esc(program.id)}/details" style="padding:12px 16px;display:grid;gap:10px">
  <div><label for="pd-name" style="font-weight:600">Name families see</label><br>
    <input id="pd-name" name="name" maxlength="120" required value="${esc(program.name)}" style="width:100%"></div>
  <div><label for="pd-desc" style="font-weight:600">Description</label><br>
    <textarea id="pd-desc" name="description" maxlength="800" style="width:100%;min-height:80px">${esc(program.description || '')}</textarea></div>
  <div><label><input type="checkbox" name="public" value="1"${program.public ? ' checked' : ''}> Listed for families (Programs page and the website)</label></div>
  <div><label><input type="checkbox" name="waitlist_enabled" value="1"${program.waitlist_enabled ? ' checked' : ''}> Keep a waiting list when groups are full</label></div>
  <div><label for="pd-mode" style="font-weight:600">How families join</label><br>
    <select id="pd-mode" name="enrollment_mode"${academy ? ' disabled' : ''}>${Object.entries(MODE)
    .map(([k, l]) => `<option value="${k}"${program.enrollment_mode === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    ${academy ? '<div class="sub" style="margin:2px 0 0">The academy always works by application.</div>' : ''}</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    <div><label for="pd-open" style="font-weight:600">Sign-up opens (Central)</label><br>
      <input id="pd-open" name="registration_opens_at" type="datetime-local" value="${esc(isoToCentral(program.registration_opens_at))}"></div>
    <div><label for="pd-close" style="font-weight:600">Sign-up closes (Central)</label><br>
      <input id="pd-close" name="registration_closes_at" type="datetime-local" value="${esc(isoToCentral(program.registration_closes_at))}"></div>
  </div>
${program.kind === 'evaluation' ? previewFields(program) : ''}  <div><button type="submit">Save details</button></div>
</form></div>`;
}
