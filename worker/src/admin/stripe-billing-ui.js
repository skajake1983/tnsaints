/**
 * The Stripe parts of Admin -> Billing, and one place's billing page.
 * Plain forms, post-redirect-get, no script.
 */

import { esc } from './ui.js';

export const STRIPE_MESSAGES = {
  provider: 'Saved. New payments now go through the chosen provider.',
  'not-configured': 'Stripe is not set up yet: add its secret key first (see PORTAL-SETUP.md). Nothing was changed.',
  saved: 'Saved.',
  cancelled: 'Marked: PayPal subscription cancelled.',
  invalid: 'That did not look right. Nothing was changed.',
  'provider-invalid': 'Choose PayPal or Stripe. Nothing was changed.',
  'cancel-invalid': 'That place was already marked, or is not a PayPal place. Nothing was changed.',
};

const money = (c) => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const day = (v) => (v ? String(v).slice(0, 10) : '—');

export function stripePanel({ overview, base = '' }) {
  const o = overview;
  const status = o.configured
    ? `Stripe ${o.env === 'live' ? 'live' : 'test mode'}${o.webhookReady ? '' : ' — <strong>webhook secret missing</strong>'}`
    : 'Stripe not set up yet (no secret key)';
  const counts = Object.entries(o.counts).map(([k, n]) => `${esc(k)} ${esc(n)}`).join(' · ') || 'none yet';
  const cancelRows = o.toCancel.length
    ? `<ul>${o.toCancel.map((r) => `<li>${esc(r.family_name)}: ${esc(r.child_name)} · PayPal ${esc(r.outside_reference || 'id not recorded')}
      · Stripe ${esc(r.status)}${r.current_period_end ? ` (next charge ${esc(day(r.current_period_end))})` : ''}
      <form class="inline" method="post" action="${esc(base)}/billing/places/${esc(r.id)}/paypal-cancelled">
        <button type="submit">Done: cancelled in PayPal</button></form></li>`).join('')}</ul>`
    : '<p class="sub" style="margin:0">None.</p>';
  const moveRows = o.toMove.length
    ? `<ul>${o.toMove.map((r) => `<li><a href="${esc(base)}/billing/places/${esc(r.id)}">${esc(r.family_name)}: ${esc(r.child_name)}</a> ·
      ${r.outside_paid_through ? `PayPal covers to ${esc(r.outside_paid_through)} — the family has been asked to move`
        : '<strong>set the last day PayPal covers</strong> so the family can move'}</li>`).join('')}</ul>`
    : '<p class="sub" style="margin:0">None.</p>';
  return `<h1>Billing</h1>
<div class="panel"><h2>Payments</h2><div style="padding:12px 16px">
  <p style="margin-top:0">${status}. Subscriptions: ${counts}.</p>
  <form method="post" action="${esc(base)}/billing/provider" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600">New payments go through</legend>
      <label><input type="radio" name="provider" value="paypal"${o.provider === 'paypal' ? ' checked' : ''}> PayPal</label>
      <label><input type="radio" name="provider" value="stripe"${o.provider === 'stripe' ? ' checked' : ''}> Stripe</label>
    </fieldset>
    <button type="submit">Save</button>
  </form>
  <p class="sub">Switching affects new payments only. Families already paying keep paying the way they started until they move.</p>
  <h3>Moved to Stripe — cancel their PayPal subscription (${o.toCancel.length})</h3>
  ${cancelRows}
  <h3>Still paying through the old Join page (${o.toMove.length})</h3>
  ${moveRows}
</div></div>`;
}

export function placeBillingBody({ detail, base = '', message = '' }) {
  const { place: p, subscriptions, payments } = detail;
  const notice = Object.hasOwn(STRIPE_MESSAGES, String(message))
    ? `<div class="notice" role="status">${esc(STRIPE_MESSAGES[message])}</div>` : '';
  const subs = subscriptions.length
    ? `<ul>${subscriptions.map((s) => `<li>${esc(s.subscription_id)} · ${esc(s.status)}${s.cancel_at_period_end ? ' · ends at period end' : ''}
      · current period to ${esc(day(s.current_period_end))}${s.coupon_id ? ` · discount ${esc(s.coupon_id.replace(/^.*_(\d+)pct$/, '$1%'))}` : ''}</li>`).join('')}</ul>`
    : '<p class="sub" style="margin:0">No Stripe subscription.</p>';
  const pays = payments.length
    ? `<table><thead><tr><th>Date</th><th>Amount</th><th>Kind</th><th>Via</th></tr></thead><tbody>${payments.map((x) =>
      `<tr><td>${esc(day(x.paid_at))}</td><td>${esc(money(Number(x.amount_cents)))}</td><td>${esc(x.kind)}</td><td>${esc(x.provider)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="sub" style="margin:0">No payments recorded.</p>';
  const paypal = p.billed_outside === 'paypal_join';
  return `<p><a href="${esc(base)}/billing">&larr; Billing</a></p>
<h1>Billing: ${esc(p.child_name)}</h1>
<p class="sub">${esc(p.family_name)} · ${esc(p.program_name)}${p.group_name ? `, ${esc(p.group_name)}` : ''} · ${esc(p.status)}</p>
${notice}
<div class="panel"><h2>Settings</h2>
<form method="post" action="${esc(base)}/billing/places/${esc(p.id)}" style="display:grid;gap:12px;padding:12px 16px;max-width:520px">
  ${p.billing === 'subscription' ? `<div><label for="sch" style="font-weight:600">Scholarship (percent off the monthly fee)</label>
    <input id="sch" name="scholarship_percent" type="number" min="1" max="100" step="1" value="${esc(p.scholarship_percent ?? '')}"
      aria-describedby="sch-hint" style="width:8em">
    <p class="sub" id="sch-hint" style="margin:2px 0 0">Optional; blank for none. It combines with the 10% sibling discount, and applies from the family's next charge.</p></div>` : ''}
  ${paypal ? `<div><label for="ppt" style="font-weight:600">Last day the family's PayPal payments cover</label>
    <input id="ppt" name="outside_paid_through" type="date" value="${esc(p.outside_paid_through || '')}" aria-describedby="ppt-hint">
    <p class="sub" id="ppt-hint" style="margin:2px 0 0">From PayPal (the day before their next PayPal payment). Once set, the family is asked to move
    to card or bank; their first new charge is the 1st after this day.${p.outside_reference ? ` PayPal subscription ${esc(p.outside_reference)}.` : ''}</p></div>` : ''}
  ${p.billing === 'subscription' || paypal ? '<div><button type="submit">Save</button></div>' : '<p class="sub" style="margin:0">Nothing to set for this place.</p>'}
</form>
${paypal && p.paypal_cancelled_at ? `<p class="sub" style="padding:0 16px 12px;margin:0">PayPal subscription cancelled ${esc(day(p.paypal_cancelled_at))}.</p>` : ''}
</div>
<div class="panel"><h2>Stripe</h2><div style="padding:12px 16px">${subs}</div></div>
<div class="panel"><h2>Payments</h2><div style="padding:12px 16px">${pays}</div></div>`;
}
