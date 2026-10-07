/**
 * Donations: records, acknowledgment receipts, annual summaries.
 *
 * FOR AFTER THE IRS DETERMINATION LETTER. Recording a gift is always possible
 * (staff keep track of sponsorship cheques today); ISSUING A RECEIPT that
 * tells a donor their gift is tax-deductible is not, until DONATIONS_ENABLED
 * is "true" AND the organisation's legal name, EIN and determination date are
 * entered — before the letter, such a receipt would be false.
 *
 * WHAT A RECEIPT SAYS follows the IRS written-acknowledgment rules
 * (Publication 1771) — TAKEN ON TRUST from that guidance and to be reviewed by
 * the accountant (plan item O15) before the first one goes out:
 *   - the organisation's name, EIN and 501(c)(3) status;
 *   - the donor's name and the date of the gift;
 *   - cash: the amount; non-cash: a description, and NO value (valuing it is
 *     the donor's job);
 *   - whether any goods or services were given in return — and if so, a
 *     description, a good-faith estimate of their value, and that the
 *     deductible amount is limited to the excess (required over $75 as a quid
 *     pro quo; stated here whenever anything was given).
 * Gifts of $250 or more NEED this acknowledgment for the donor to deduct them.
 *
 * FROZEN. An issued receipt's text and the gift's details cannot change
 * (database trigger); a mistake is voided, with a reason, and recorded again.
 * PROGRAM FEES are never here (see migration 017).
 */

import { flag } from '../lib/flags.js';
import { realDate } from '../governance/board.js';

const EIN_RE = /^\d{2}-\d{7}$/;
const MONEY = /^\d{1,7}(\.\d{2})?$/;
const SETTINGS = ['legal_name', 'ein', 'determination_date', 'signer_name', 'signer_title'];
const iso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const METHODS = { check: 'Check', cash: 'Cash', card: 'Card', paypal: 'PayPal', transfer: 'Bank transfer', other: 'Other' };

export function donationsEnabled(env) {
  return flag(env, 'DONATIONS_ENABLED', false);
}

export async function donationSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM app_settings WHERE key IN (SELECT 'donations.' || value FROM json_each(?1))`
  ).bind(JSON.stringify(SETTINGS)).all();
  const s = Object.fromEntries((results || []).map((r) => [r.key.slice('donations.'.length), r.value]));
  return { ...s, complete: SETTINGS.every((k) => s[k]) };
}

/** @returns {Promise<'saved'|'invalid'>} */
export async function saveDonationSettings(env, form, actor) {
  const v = {
    legal_name: clean(form.get('legal_name'), 160),
    ein: clean(form.get('ein'), 10),
    determination_date: String(form.get('determination_date') || ''),
    signer_name: clean(form.get('signer_name'), 80),
    signer_title: clean(form.get('signer_title'), 80),
  };
  if (!v.legal_name || v.legal_name.length > 160 || !EIN_RE.test(v.ein) || !realDate(v.determination_date)
      || !v.signer_name || v.signer_name.length > 80 || !v.signer_title || v.signer_title.length > 80) return 'invalid';
  const now = iso();
  await env.DB.batch(SETTINGS.map((k) => env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(`donations.${k}`, v[k], actor, now)));
  return 'saved';
}

function cents(raw) {
  const s = String(raw || '').trim().replace(/,/g, '');
  if (!s) return null;
  return MONEY.test(s) ? Math.round(Number(s) * 100) : NaN;
}

export function validateDonation(form) {
  const v = {
    donorName: clean(form.get('donor_name'), 120),
    donorAddress: String(form.get('donor_address') || '').trim().slice(0, 301),
    receivedOn: String(form.get('received_on') || ''),
    kind: String(form.get('kind') || 'cash'),
    amountCents: cents(form.get('amount')),
    noncash: String(form.get('noncash_description') || '').trim().slice(0, 501),
    method: String(form.get('method') || ''),
    goodsCents: cents(form.get('goods_services_value')) ?? 0,
    goodsDescription: String(form.get('goods_services_description') || '').trim().slice(0, 301),
    restricted: clean(form.get('restricted_purpose'), 200),
    notes: String(form.get('notes') || '').trim().slice(0, 501),
    contactId: /^\d{1,12}$/.test(String(form.get('contact_id') || '')) ? Number(form.get('contact_id')) : null,
  };
  const errors = {};
  if (!v.donorName || v.donorName.length > 120) errors.donor_name = 'Enter the donor as the receipt should name them.';
  if (!realDate(v.receivedOn)) errors.received_on = 'Enter the date the gift was received.';
  if (!['cash', 'noncash'].includes(v.kind)) errors.kind = 'Choose money or a non-cash gift.';
  if (v.kind === 'cash' && !(Number.isInteger(v.amountCents) && v.amountCents > 0)) errors.amount = 'Enter the amount, like 250.00.';
  if (v.kind === 'cash' && !Object.hasOwn(METHODS, v.method)) errors.method = 'Choose how it was given.';
  if (v.kind === 'noncash' && !v.noncash) errors.noncash_description = 'Describe what was given (the academy does not value it).';
  if (!Number.isInteger(v.goodsCents) || v.goodsCents < 0) errors.goods_services_value = 'Enter a value like 40.00, or leave it blank.';
  if (v.goodsCents > 0 && !v.goodsDescription) errors.goods_services_description = 'Describe what the donor received in return.';
  if (v.kind === 'cash' && Number.isInteger(v.amountCents) && v.goodsCents > v.amountCents) {
    errors.goods_services_value = 'What they received cannot be worth more than they gave.';
  }
  if (v.donorAddress.length > 300 || v.noncash.length > 500 || v.goodsDescription.length > 300 || v.notes.length > 500) {
    errors.notes = 'One of the fields is too long.';
  }
  return { value: v, errors };
}

export async function recordDonation(env, v, actor) {
  const now = iso();
  const row = await env.DB.prepare(
    `INSERT INTO donations (contact_id, household_id, donor_name, donor_address, received_on, kind, amount_cents, noncash_description,
                            method, goods_services_cents, goods_services_description, restricted_purpose, notes, recorded_by,
                            created_at, updated_at)
     VALUES ((SELECT id FROM crm_contacts WHERE id = ?1), (SELECT household_id FROM crm_contacts WHERE id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
     RETURNING id`
  ).bind(v.contactId, v.donorName, v.donorAddress || null, v.receivedOn, v.kind, v.kind === 'cash' ? v.amountCents : null,
    v.kind === 'noncash' ? v.noncash : null, v.kind === 'cash' ? v.method : null, v.goodsCents, v.goodsCents > 0 ? v.goodsDescription : null,
    v.restricted || null, v.notes || null, actor, now).first();
  return Number(row.id);
}

export async function listDonations(env, year) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM donations WHERE substr(received_on, 1, 4) = ?1 ORDER BY received_on DESC, id DESC LIMIT 1000`
  ).bind(String(year)).all();
  return results || [];
}

export async function getDonation(env, id) {
  return env.DB.prepare(`SELECT * FROM donations WHERE id = ?1`).bind(id).first();
}

const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

/** The acknowledgment, as it would be issued today. Plain text; frozen when issued. */
export function receiptText(d, s, { number, issuedOn }) {
  const lines = [
    s.legal_name,
    `EIN ${s.ein}`,
    '',
    `Acknowledgment of your contribution — receipt ${number}, ${longDate(issuedOn)}`,
    '',
    `Dear ${d.donor_name},`,
    '',
  ];
  if (d.kind === 'cash') {
    lines.push(`Thank you for your contribution of ${dollars(d.amount_cents)}, received on ${longDate(d.received_on)}.`);
  } else {
    lines.push(`Thank you for your contribution, received on ${longDate(d.received_on)}, of: ${d.noncash_description}.`,
      `${s.legal_name} does not assign a value to non-cash contributions.`);
  }
  if (d.restricted_purpose) lines.push(`At your request, it is designated for: ${d.restricted_purpose}.`);
  lines.push('');
  if (d.goods_services_cents > 0) {
    lines.push(`In exchange for your contribution you received: ${d.goods_services_description}, which we estimate in good faith to be worth ${dollars(d.goods_services_cents)}.`);
    if (d.kind === 'cash') {
      lines.push(`The amount of your contribution that is deductible for federal income tax purposes is limited to the excess of the amount you gave over that value: ${dollars(d.amount_cents - d.goods_services_cents)}.`);
    } else {
      lines.push('The amount deductible for federal income tax purposes is limited to the value of what you gave in excess of that amount.');
    }
  } else {
    lines.push('No goods or services were provided in exchange for this contribution.');
  }
  lines.push('',
    `${s.legal_name} is a tax-exempt organization under section 501(c)(3) of the Internal Revenue Code (determination letter dated ${longDate(s.determination_date)}). Please keep this acknowledgment for your tax records.`,
    '', 'With our thanks,', '', s.signer_name, s.signer_title);
  return lines.join('\n');
}

/**
 * Issue (and freeze) the receipt for a gift.
 * @returns {Promise<{result: 'issued'|'disabled'|'settings'|'voided'|'already'|'not-found', number?: string}>}
 */
export async function issueReceipt(env, id, actor) {
  if (!donationsEnabled(env)) return { result: 'disabled' };
  const s = await donationSettings(env);
  if (!s.complete) return { result: 'settings' };
  const d = await getDonation(env, id);
  if (!d) return { result: 'not-found' };
  if (d.voided_at) return { result: 'voided' };
  if (d.receipt_issued_at) return { result: 'already', number: d.receipt_number };
  const issuedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  const year = issuedOn.slice(0, 4);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seq = await env.DB.prepare(
      `SELECT COUNT(*) + 1 + ?2 AS n FROM donations WHERE receipt_number LIKE ?1`
    ).bind(`TS-${year}-%`, attempt).first();
    const number = `TS-${year}-${String(seq.n).padStart(4, '0')}`;
    try {
      const res = await env.DB.prepare(
        `UPDATE donations SET receipt_number = ?2, receipt_issued_at = ?3, receipt_text = ?4, updated_at = ?3
          WHERE id = ?1 AND receipt_issued_at IS NULL AND voided_at IS NULL`
      ).bind(id, number, iso(), receiptText(d, s, { number, issuedOn })).run();
      return res.meta?.changes ? { result: 'issued', number } : { result: 'already' };
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
  throw new Error('could not number the receipt');
}

/** Void a gift (entered in error, a bounced check): it stays on record, marked, with the reason. */
export async function voidDonation(env, id, reason, actor) {
  const why = clean(reason, 200);
  if (!why || why.length > 200) return false;
  const res = await env.DB.prepare(
    `UPDATE donations SET voided_at = ?2, void_reason = ?3, notes = COALESCE(notes || char(10), '') || ?4, updated_at = ?2
      WHERE id = ?1 AND voided_at IS NULL`
  ).bind(id, iso(), why, `Voided by ${actor}`).run();
  return Boolean(res.meta?.changes);
}

/** A donor's gifts in a year (for their annual statement), by contact or by the name on the receipts. */
export async function annualSummary(env, { year, contactId = null, donorName = '' }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM donations WHERE substr(received_on, 1, 4) = ?1 AND voided_at IS NULL
        AND ((?2 IS NOT NULL AND contact_id = ?2) OR (?2 IS NULL AND lower(donor_name) = lower(?3)))
      ORDER BY received_on`
  ).bind(String(year), contactId, donorName).all();
  const gifts = results || [];
  return {
    gifts,
    cashTotal: gifts.filter((g) => g.kind === 'cash').reduce((sum, g) => sum + g.amount_cents, 0),
    goodsTotal: gifts.reduce((sum, g) => sum + g.goods_services_cents, 0),
  };
}

export { dollars };
