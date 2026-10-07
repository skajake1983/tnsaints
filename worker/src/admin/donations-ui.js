/**
 * Donations: the year's gifts, recording one, a gift's receipt, the
 * organisation's receipt details, and a donor's annual statement.
 */

import { esc } from './ui.js';
import { METHODS, dollars } from '../donations/donations.js';

export const DONATION_STYLES = `
  .dform { display:grid; gap:10px; padding:12px 16px; }
  .dform label { font-weight:600; font-size:14px; display:block; margin-bottom:3px; }
  .dform input, .dform select, .dform textarea { font:inherit; font-size:14px; padding:6px 8px; min-height:36px;
            border:1px solid var(--line); border-radius:6px; width:100%; box-sizing:border-box; }
  .dform button, .inline button { font:inherit; font-size:14px; padding:6px 12px; min-height:36px; border-radius:6px;
            border:1px solid var(--navy); background:var(--navy); color:#fff; cursor:pointer; }
  .inline { display:inline; }
  .inline button.light { background:#fff; color:var(--navy); }
  .err { color:var(--danger); font-size:13px; }
  .receipt { white-space:pre-wrap; font-family: Georgia, serif; font-size:15px; padding:20px 24px; background:#fff; }
  .warn { color:var(--warn); font-weight:700; }
  @media (min-width: 760px) { .dform.cols { grid-template-columns: 1fr 1fr; } .dform .wide { grid-column: 1 / -1; } }
  @media print { header, nav, .noprint, footer { display:none !important; } .receipt { padding:0; } }
`;

export const DONATION_MESSAGES = {
  recorded: 'Recorded.', issued: 'Receipt issued. Print it or save it as a PDF and send it from your own email.',
  disabled: 'Receipts are switched off until the IRS determination letter (DONATIONS_ENABLED).',
  settings: 'Enter the organisation’s legal name, EIN, determination date and signer first.',
  voided: 'This gift is voided.', already: 'That receipt was already issued.', saved: 'Saved.', invalid: 'That did not look right. Nothing was changed.',
};

const notice = (m) => (Object.hasOwn(DONATION_MESSAGES, String(m)) ?`<div class="notice" role="status">${esc(DONATION_MESSAGES[m])}</div>` : '');

function gate({ enabled, settings }) {
  if (!enabled) {
    return `<div class="notice"><strong>Receipts are off.</strong> Gifts can be recorded, but a receipt telling a donor their gift is
tax-deductible is only true once the IRS determination letter has arrived. Then: enter the details below, and switch DONATIONS_ENABLED on.</div>`;
  }
  if (!settings.complete) return '<div class="notice"><strong>Receipts need the organisation’s details</strong> (below) before the first one is issued.</div>';
  return '';
}

export function donationsBody({ year, rows, enabled, settings, canManage, base, message, values = {}, errors = {} }) {
  const live = rows.filter((r) => !r.voided_at);
  const cash = live.filter((r) => r.kind === 'cash').reduce((s, r) => s + r.amount_cents, 0);
  const err = (k) => (errors[k] ? `<div class="err" id="e-${k}">${esc(errors[k])}</div>` : '');
  const v = (k) => esc(values[k] ?? '');
  return `<h1>Donations</h1>
<p class="sub">Gifts to the academy. A family's program fee is never a donation, and nothing here can make it one.</p>
${notice(message)}${gate({ enabled, settings })}
<form method="get" action="${esc(base)}/donations" class="noprint" style="margin:0 0 12px"><label for="yr">Year</label>
  <input id="yr" name="year" type="number" min="2020" max="2100" value="${esc(year)}" style="width:7em"> <button type="submit">Show</button></form>
<div class="cards"><div class="card"><div class="n">${esc(dollars(cash))}</div><div class="l">Money given in ${esc(year)}</div></div>
<div class="card"><div class="n">${esc(live.length)}</div><div class="l">Gifts</div></div>
<div class="card"><div class="n">${esc(live.filter((r) => !r.receipt_issued_at && (r.kind === 'noncash' || r.amount_cents >= 25000)).length)}</div>
<div class="l">$250+ or non-cash without a receipt</div></div></div>
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Received</th><th>Donor</th><th>Gift</th><th>Receipt</th></tr></thead>
<tbody>${rows.map((r) => `<tr${r.voided_at ? ' style="opacity:.55"' : ''}><td data-label="Received">${esc(r.received_on)}</td>
  <td data-label="Donor"><a href="${esc(base)}/donations/${esc(r.id)}">${esc(r.donor_name)}</a></td>
  <td data-label="Gift">${r.kind === 'cash' ? esc(dollars(r.amount_cents)) : esc(r.noncash_description)}${r.goods_services_cents ? ` (received ${esc(dollars(r.goods_services_cents))} in return)` : ''}</td>
  <td data-label="Receipt">${r.voided_at ? 'Voided' : r.receipt_number ? esc(r.receipt_number) : (r.kind === 'noncash' || r.amount_cents >= 25000) ? '<span class="warn">Needed</span>' : 'Not issued'}</td></tr>`).join('')
    || '<tr><td colspan="4">No gifts recorded this year.</td></tr>'}</tbody></table></div></div>
${canManage ? `<div class="panel noprint"><h2>Record a gift</h2><form class="dform cols" method="post" action="${esc(base)}/donations" novalidate>
  ${Object.keys(errors).length ? '<div class="notice wide" role="alert">Please fix the highlighted fields.</div>' : ''}
  <div><label for="dn">Donor, as the receipt should name them (required)</label><input id="dn" name="donor_name" maxlength="120" value="${v('donorName')}">${err('donor_name')}</div>
  <div><label for="dr">Received on (required)</label><input id="dr" name="received_on" type="date" value="${v('receivedOn')}">${err('received_on')}</div>
  <div><label for="dk">Gift</label><select id="dk" name="kind"><option value="cash"${values.kind === 'noncash' ? '' : ' selected'}>Money</option>
    <option value="noncash"${values.kind === 'noncash' ? ' selected' : ''}>Something other than money</option></select>${err('kind')}</div>
  <div><label for="da">Amount, for money ($)</label><input id="da" name="amount" inputmode="decimal" value="${values.amountCents ? esc((values.amountCents / 100).toFixed(2)) : ''}">${err('amount')}</div>
  <div><label for="dm">How, for money</label><select id="dm" name="method"><option value="">—</option>${Object.entries(METHODS)
    .map(([k, l]) => `<option value="${k}"${values.method === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${err('method')}</div>
  <div><label for="dnc">What was given, if not money</label><input id="dnc" name="noncash_description" maxlength="500" value="${v('noncash')}">${err('noncash_description')}</div>
  <div><label for="dgv">Value of anything given in return ($)</label><input id="dgv" name="goods_services_value" inputmode="decimal">
    <div class="sub" style="margin:2px 0 0">A dinner ticket, a banner, a shirt — a good-faith estimate. Leave blank if nothing.</div>${err('goods_services_value')}</div>
  <div><label for="dgd">What was given in return</label><input id="dgd" name="goods_services_description" maxlength="300" value="${v('goodsDescription')}">${err('goods_services_description')}</div>
  <div><label for="dp">Restricted to a purpose</label><input id="dp" name="restricted_purpose" maxlength="200" value="${v('restricted')}"></div>
  <div><label for="dad">Donor's address (for the receipt)</label><input id="dad" name="donor_address" maxlength="300" value="${v('donorAddress')}"></div>
  <div class="wide"><label for="dno">Notes (staff only)</label><input id="dno" name="notes" maxlength="500" value="${v('notes')}">${err('notes')}</div>
  <div class="wide"><button type="submit">Record</button></div></form></div>
<div class="panel noprint"><h2>The organisation, for receipts</h2><form class="dform cols" method="post" action="${esc(base)}/donations/settings">
  <div class="wide"><label for="sl">Legal name</label><input id="sl" name="legal_name" maxlength="160" value="${esc(settings.legal_name || '')}"></div>
  <div><label for="se">EIN</label><input id="se" name="ein" maxlength="10" placeholder="12-3456789" value="${esc(settings.ein || '')}"></div>
  <div><label for="sd">IRS determination letter date</label><input id="sd" name="determination_date" type="date" value="${esc(settings.determination_date || '')}"></div>
  <div><label for="ssn">Signed by</label><input id="ssn" name="signer_name" maxlength="80" value="${esc(settings.signer_name || '')}"></div>
  <div><label for="sst">Their title</label><input id="sst" name="signer_title" maxlength="80" value="${esc(settings.signer_title || '')}"></div>
  <div class="wide"><button type="submit">Save</button></div></form></div>` : ''}`;
}

export function donationBody({ d, preview, canManage, base, message, receiptsReady }) {
  return `<p class="noprint"><a href="${esc(base)}/donations">&larr; All donations</a></p>
<h1 class="noprint">${esc(d.donor_name)} · ${esc(d.received_on)}</h1>
${notice(message)}
${d.voided_at ? `<div class="notice">Voided ${esc(String(d.voided_at).slice(0, 10))}: ${esc(d.void_reason)}</div>` : ''}
<div class="panel"><h2 class="noprint">${d.receipt_issued_at ? `Receipt ${esc(d.receipt_number)} (issued, frozen)` : 'Receipt preview — not issued'}</h2>
<div class="receipt">${esc(d.receipt_text || preview || 'Enter the organisation’s details to preview the receipt.')}</div></div>
${canManage && !d.voided_at ? `<div class="noprint">${!d.receipt_issued_at ? `<form class="inline" method="post" action="${esc(base)}/donations/${esc(d.id)}/receipt">
  <button type="submit"${receiptsReady ? '' : ' disabled'}>Issue this receipt</button></form>` : ''}
<form class="dform" method="post" action="${esc(base)}/donations/${esc(d.id)}/void" style="max-width:460px">
  <label for="vr">Void this gift (it stays on record, marked)</label><input id="vr" name="reason" maxlength="200" required placeholder="Reason, e.g. check returned">
  <div><button class="light" type="submit">Void</button></div></form></div>` : ''}`;
}

export function summaryBody({ year, donorName, summary, base }) {
  return `<p class="noprint"><a href="${esc(base)}/donations">&larr; All donations</a></p>
<h1>${esc(year)} giving: ${esc(donorName)}</h1>
<div class="panel"><div class="scroll"><table class="stack"><thead><tr><th>Received</th><th>Gift</th><th>Given in return</th><th>Receipt</th></tr></thead>
<tbody>${summary.gifts.map((g) => `<tr><td data-label="Received">${esc(g.received_on)}</td>
  <td data-label="Gift">${g.kind === 'cash' ? esc(dollars(g.amount_cents)) : esc(g.noncash_description)}</td>
  <td data-label="In return">${g.goods_services_cents ? `${esc(g.goods_services_description)} (${esc(dollars(g.goods_services_cents))})` : 'Nothing'}</td>
  <td data-label="Receipt">${esc(g.receipt_number || '—')}</td></tr>`).join('') || '<tr><td colspan="4">No gifts.</td></tr>'}</tbody></table></div></div>
<p>Money given: <strong>${esc(dollars(summary.cashTotal))}</strong>${summary.goodsTotal ? ` · value of goods and services received in return: ${esc(dollars(summary.goodsTotal))}` : ''}.</p>`;
}
