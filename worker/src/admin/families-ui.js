/**
 * Portal families for staff: who is in each family, each child's grade, shirt
 * size, medical flag and academy status, and practice-shirt totals.
 *
 * Cards, not a wide table, so it reads on a phone without sideways scrolling.
 * No script: a medical note opens on its own page, which is audited on the
 * server when it is read.
 */

import { esc, backButton } from './ui.js';
import { gradeLabel } from '../lib/grades.js';

const SIZE_ORDER = ['YXS', 'YS', 'YM', 'YL', 'YXL', 'AS', 'AM', 'AL', 'AXL', 'A2XL', 'Not given'];
const ACADEMY = {
  applied: 'Applied', waitlist: 'Waiting list', offered: 'Offered', active: 'Enrolled', past_due: 'Payment due',
};

export const FAMILY_STYLES = `
  .fam { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:12px; }
  .fam h2 { font-size:16px; margin:0 0 6px; }
  .fam .who { font-size:14px; color: var(--muted); margin-bottom:8px; }
  .kid { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; padding:8px 0; border-top:1px solid var(--line); font-size:14px; }
  .kid strong { font-size:15px; min-width: 140px; }
  .tag { font-size:12px; font-weight:700; padding:2px 8px; border-radius:99px; background:#eef1f6; }
  .tag.med { background:#f6e5e5; color: var(--danger); }
  .tag.warn { background:#fdf0dd; color:#7a4a09; }
  .sizes { font-size:15px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

function sizesLine(map) {
  const entries = [...map].sort((a, b) => SIZE_ORDER.indexOf(a[0]) - SIZE_ORDER.indexOf(b[0]));
  return entries.length ? entries.map(([s, n]) => `<strong>${esc(s)}</strong> ${n}`).join(' · ') : 'None yet';
}

const FAMILY_MESSAGES = {
  invited: 'Invitation sent. They can now sign in with that address.',
  'invited-no-email': "Their account is ready, but the email didn't send (daily allowance or provider). Tell them to sign in at the portal with that address.",
  invalid: "That didn't look like an email address.",
};

export function familiesBody({ families, contact, medical, totals, base = '', message = '', canInvite = false, invited = [] }) {
  const childCount = families.reduce((n, f) => n + f.children.length, 0);
  const cards = families.length
    ? families
        .map((f) => {
          const guardians = f.guardians
            .map((g) => `${esc(g.name || 'Guardian')}${g.relationship ? ` (${esc(g.relationship)})` : ''}${
              contact ? ` · ${esc(g.email || '')}${g.phone ? ` · ${esc(g.phone)}` : ''}` : ''}`)
            .join('<br>');
          const kids = f.children.length
            ? f.children
                .map((c) => {
                  const med = c.medical === 'declared'
                    ? (medical
                      ? `<a class="tag med" href="${esc(base)}/families/children/${esc(c.id)}/medical">Medical note</a>`
                      : '<span class="tag med">Medical note</span>')
                    : c.medical === 'none_declared' ? '<span class="tag">No medical</span>' : '<span class="tag warn">Medical not answered</span>';
                  return `<div class="kid"><strong>${esc(c.name)}</strong>
  <span>${esc(c.grade === null ? '' : gradeLabel(c.grade))}</span>
  <span>Shirt ${esc(c.shirtSize || '—')}</span>
  ${med}
  ${c.academy ? `<span class="tag">${esc(ACADEMY[c.academy] || c.academy)}${c.group ? `: ${esc(c.group)}` : ''}</span>` : ''}</div>`;
                })
                .join('')
            : '<div class="kid">No children added yet.</div>';
          const ec = contact
            ? `<div class="who" style="margin-top:8px">Emergency: ${f.contacts.length
              ? f.contacts.map((c) => `${esc(c.name)}${c.relationship ? ` (${esc(c.relationship)})` : ''} ${esc(c.phone)}`).join(' · ')
              : '<span class="tag warn">none</span>'}</div>`
            : '';
          return `<div class="fam"><h2>${esc(f.display_name || 'Family')}</h2><div class="who">${guardians}</div>${kids}${ec}</div>`;
        })
        .join('')
    : '<div class="empty">No families have signed up yet.</div>';

  const invite = canInvite ? `<div class="panel"><h2>Invite a family</h2>
<form method="post" action="${esc(base)}/families/invite" style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px">
  <label class="sr" for="invite-email">Parent's email</label>
  <input id="invite-email" name="email" type="email" required placeholder="parent@example.com" style="font:inherit;padding:8px 10px;min-width:260px">
  <button type="submit">Send invitation</button></form>
<p class="sub" style="padding:0 16px 12px;margin:0">While the portal is invite-only, this is how a family gets in. The email has no special link:
they sign in at the portal with that address.</p>
${invited.length ? `<p class="sub" style="padding:0 16px 12px;margin:0">Invited, not set up yet: ${invited.map((a) => esc(a.email)).join(', ')}</p>` : ''}</div>` : '';
  return `<h1>Families</h1>
<p class="sub">${families.length} ${families.length === 1 ? 'family' : 'families'} and ${childCount} ${childCount === 1 ? 'child' : 'children'} on the parent portal.</p>
${message && FAMILY_MESSAGES[message] ? `<div class="notice" role="status">${esc(FAMILY_MESSAGES[message])}</div>` : ''}
${invite}
<div class="panel"><h2>Practice shirts</h2><div style="padding:12px 16px" class="sizes">
  <p style="margin:0 0 6px">To order (offered or enrolled): ${sizesLine(totals.placed)}</p>
  <p style="margin:0;color:var(--muted)">All children: ${sizesLine(totals.all)}</p>
</div></div>
${cards}`;
}

export function medicalBody({ child, base = '' }) {
  const note = child.status === 'declared'
    ? `<div class="notice" style="white-space:pre-wrap">${esc(child.notes)}</div>`
    : child.status === 'none_declared' ? '<p>The family answered: nothing to declare.</p>' : '<p>The family has not answered yet.</p>';
  return `${backButton(`${base}/families`, 'Families')}
<h1>${esc(child.display_name)}</h1>
<p class="sub">${esc(child.family_name || '')}. This view has been recorded in the audit log.</p>
${note}
${child.updated_at ? `<p class="sub">Last updated ${esc(String(child.updated_at).slice(0, 10))}.</p>` : ''}`;
}
