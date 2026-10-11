/**
 * Admin -> Families -> Add a place: give a child who already practises (and
 * pays outside the portal) a place, so the family can sign the waiver.
 * A plain form, no script.
 */

import { esc } from './ui.js';
import { PAID_OUTSIDE } from '../programs/places.js';

export const PLACE_STYLES = `
  .pform { display:grid; gap:14px; padding:14px 16px; max-width:640px; }
  .pform label, .pform legend { font-weight:600; font-size:14px; }
  .pform select, .pform input[type=text] { font:inherit; font-size:15px; padding:8px 10px; min-height:40px; width:100%;
            box-sizing:border-box; border:1px solid var(--line); border-radius:6px; }
  .pform fieldset { border:0; padding:0; margin:0; display:grid; gap:6px; }
  .pform .hint { font-size:13px; color:var(--muted); margin:2px 0 0; }
  .pform .err { color:var(--danger); font-size:13px; margin:2px 0 0; }
  .pform button { font:inherit; font-weight:700; padding:9px 16px; min-height:40px; border-radius:6px; border:1px solid var(--navy);
            background:var(--navy); color:#fff; cursor:pointer; justify-self:start; }
`;

const FIELD_ORDER = ['group_id', 'billed_outside', 'outside_reference'];

function groupOptions(options, chosen) {
  const byProgram = new Map();
  for (const o of options) {
    if (!byProgram.has(o.program_id)) byProgram.set(o.program_id, { name: o.program_name, status: o.program_status, groups: [] });
    byProgram.get(o.program_id).groups.push(o);
  }
  return [...byProgram.values()].map((p) => `<optgroup label="${esc(p.name)}${p.status === 'open' ? '' : ` (${p.status})`}">${p.groups
    .map((g) => {
      const full = Number(g.taken) >= Number(g.capacity);
      return `<option value="${esc(g.id)}"${Number(chosen) === Number(g.id) ? ' selected' : ''}${full ? ' disabled' : ''}>${esc(g.name)} — ${esc(g.schedule_summary)} (${esc(g.taken)} of ${esc(g.capacity)} seats${full ? ', full' : ''})</option>`;
    }).join('')}</optgroup>`).join('');
}

export function placeBody({ child, options, base, values = {}, errors = {} }) {
  const err = (k) => (errors[k] ? `<p class="err" id="e-${k}">${esc(errors[k])}</p>` : '');
  const described = (k, hint) => [hint, errors[k] ? `e-${k}` : ''].filter(Boolean).join(' ');
  const wrong = FIELD_ORDER.filter((k) => errors[k]);
  const summary = wrong.length
    ? `<div class="notice" role="alert" tabindex="-1"><strong>Please fix:</strong><ul style="margin:6px 0 0">${wrong
      .map((k) => `<li><a href="#${k === 'billed_outside' ? 'bo-paypal_join' : k}">${esc(errors[k])}</a></li>`).join('')}</ul></div>`
    : '';
  const existing = child.places.length
    ? `<p class="sub">Already: ${child.places.map((p) => `${esc(p.program_name)} (${esc(p.status)}${p.group_name ? `, ${esc(p.group_name)}` : ''})`).join('; ')}</p>`
    : '';
  const form = options.length
    ? `<form class="pform" method="post" action="${esc(base)}/families/children/${esc(child.id)}/place" novalidate>
  <div><label for="group_id">Group (required)</label>
    <select id="group_id" name="group_id" aria-describedby="${esc(described('group_id', 'group-hint'))}">
      <option value="">Choose a group</option>${groupOptions(options, values.groupId)}</select>
    <p class="hint" id="group-hint">The group they practise with. A full group can't be chosen: raise its seats on the program's page first.</p>${err('group_id')}</div>
  <fieldset aria-describedby="${esc(described('billed_outside', ''))}"><legend>How does the family pay today? (required)</legend>
    ${Object.entries(PAID_OUTSIDE).map(([k, label]) => `<label style="font-weight:400"><input type="radio" id="bo-${k}" name="billed_outside" value="${k}"${values.billedOutside === k ? ' checked' : ''}> ${esc(label)}</label>`).join('')}
    ${err('billed_outside')}</fieldset>
  <div><label for="outside_reference">PayPal subscription id (optional)</label>
    <input id="outside_reference" name="outside_reference" type="text" maxlength="42" autocomplete="off" value="${esc(values.reference || '')}"
      aria-describedby="${esc(described('outside_reference', 'ref-hint'))}">
    <p class="hint" id="ref-hint">From the family's PayPal receipt, like I-ABC123DEF456. It lets us cancel the right PayPal subscription when they move to the new payments.</p>${err('outside_reference')}</div>
  <button type="submit">Add the place</button>
</form>`
    : `<div class="empty">There are no active groups yet. Add the groups on the program's page (Programs) first.</div>`;
  return `<p><a href="${esc(base)}/families">&larr; Families</a></p>
<h1>Add a place for ${esc(child.display_name)}</h1>
<p class="sub">${esc(child.household_name || 'Family')} · For a child who already practises and pays outside the portal. The place starts today,
and the family is asked to sign the waiver the next time they sign in.</p>
${existing}${summary}<div class="panel">${form}</div>`;
}
