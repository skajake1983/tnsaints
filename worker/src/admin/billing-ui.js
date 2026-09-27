/**
 * Billing reconciliation for staff: PayPal subscriptions the system could not
 * place by itself, and places that were paid for without a seat.
 *
 * PayPal has no API to list every subscription, so families who paid on the
 * old Join page are matched one at a time: paste the I-… id from PayPal's
 * dashboard, check it is the right family (payer details are shown live and
 * never stored), then link it to their child and a group.
 *
 * No script; plain forms, post-redirect-get.
 */

import { esc } from './ui.js';

const MESSAGES = {
  imported: 'Subscription recorded. If PayPal knew which place it was for, it is already linked.',
  'not-found': 'PayPal does not know that subscription (check the id and the sandbox/live setting).',
  linked: 'Linked. The family will be asked to sign the waiver when they next sign in.',
  full: 'That group is full. Nothing was changed.',
  state: 'That subscription has already been handled. Nothing was changed.',
  synced: 'Re-read from PayPal.',
  invalid: 'That did not look like a PayPal subscription id (I-…).',
};

export const BILLING_STYLES = `
  .sub-row { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:10px; font-size:14px; }
  .sub-row form { display:inline-flex; gap:6px; align-items:center; margin:6px 10px 0 0; flex-wrap: wrap; }
  .sub-row select, .sub-row button, .lookup input, .lookup button { font: inherit; font-size: 14px; padding: 6px 8px; min-height: 36px; }
  .lookup { display:flex; gap:8px; flex-wrap:wrap; padding: 12px 16px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  dl.live { display:grid; grid-template-columns: max-content 1fr; gap: 4px 14px; padding: 0 16px 14px; margin: 0; }
  dl.live dt { color: var(--muted); }
`;

export function billingBody({ unlinked, paidNoSeat, children, groups, found, message, env, base = '' }) {
  const childOptions = children
    .map((c) => `<option value="${esc(c.id)}">${esc(c.family_name)}: ${esc(c.display_name)}${c.academy_status ? ` (${esc(c.academy_status)})` : ''}</option>`)
    .join('');
  const groupOptions = groups
    .filter((g) => g.status === 'active')
    .map((g) => `<option value="${esc(g.id)}"${Number(g.taken) >= Number(g.capacity) ? ' disabled' : ''}>${esc(g.name)} (${esc(g.taken)}/${esc(g.capacity)})</option>`)
    .join('');

  const live = found
    ? `<dl class="live">
  <dt>Subscription</dt><dd>${esc(found.id)} · ${esc(found.status)}</dd>
  <dt>Payer</dt><dd>${esc(found.payerName || '—')} ${found.payerEmail ? `&lt;${esc(found.payerEmail)}&gt;` : ''}</dd>
  <dt>Plan</dt><dd>${esc(found.planId || '—')}</dd>
  <dt>Started</dt><dd>${esc(String(found.startTime).slice(0, 10) || '—')}</dd>
  <dt>Next payment</dt><dd>${esc(String(found.nextBilling).slice(0, 10) || '—')}</dd>
  <dt>Placed via</dt><dd>${esc(found.customId || 'none (old Join page)')}</dd>
</dl>
<form method="post" action="${esc(base)}/billing/import" style="padding:0 16px 14px"><input type="hidden" name="subscription_id" value="${esc(found.id)}">
  <button type="submit">Record this subscription</button></form>`
    : '';

  const rows = unlinked.length
    ? unlinked
        .map((s) => `<div class="sub-row"><strong>${esc(s.paypal_subscription_id)}</strong> · ${esc(s.status)} · ${esc(s.environment)}
  · from ${esc(s.source)} · first seen ${esc(String(s.created_at).slice(0, 10))}
  <div>
    <form method="post" action="${esc(base)}/billing/${esc(s.id)}/sync"><button type="submit">Re-read from PayPal</button></form>
    ${childOptions && groupOptions ? `<form method="post" action="${esc(base)}/billing/${esc(s.id)}/link">
      <label class="sr" for="c${esc(s.id)}">Child</label><select id="c${esc(s.id)}" name="player_id" required>${childOptions}</select>
      <label class="sr" for="g${esc(s.id)}">Group</label><select id="g${esc(s.id)}" name="group_id" required>${groupOptions}</select>
      <button type="submit">Link to this child</button></form>` : '<span class="sub">Add the family on the portal and a group first.</span>'}
  </div></div>`)
        .join('')
    : '<div class="empty">Nothing waiting to be matched.</div>';

  const noSeat = paidNoSeat.length
    ? `<div class="panel"><h2>Paid, but no seat to give</h2><div style="padding:12px 16px">
  <p style="margin-top:0">These families paid after their offer lapsed and the group filled. Offer a seat from the queue, or refund in PayPal.</p>
  <ul>${paidNoSeat.map((r) => `<li>${esc(r.family_name)}: ${esc(r.child_name)} (${esc(r.status)}, ${esc(String(r.at).slice(0, 10))})</li>`).join('')}</ul>
</div></div>`
    : '';

  return `<h1>Billing</h1>
<p class="sub">PayPal (${esc(env)}): subscriptions to match with a child, and payments that need a person.</p>
${message && MESSAGES[message] ? `<div class="notice" role="status">${esc(MESSAGES[message])}</div>` : ''}
${noSeat}
<div class="panel"><h2>Look up a subscription</h2>
<form class="lookup" method="get" action="${esc(base)}/billing">
  <label class="sr" for="lookup">PayPal subscription id</label>
  <input id="lookup" name="lookup" placeholder="I-XXXXXXXXXXXX" pattern="I-[A-Z0-9]+" required>
  <button type="submit">Look up in PayPal</button>
</form>
<p class="sub" style="padding:0 16px">PayPal cannot list every subscription, so old Join-page families are matched by pasting the id from PayPal's dashboard. Payer details are shown here and not saved.</p>
${live}</div>
<div class="panel"><h2>Waiting to be matched (${unlinked.length})</h2><div style="padding:12px 16px">${rows}</div></div>`;
}
