/**
 * The Stripe rules that need no server (src/payments/stripe*.js): when and how
 * the first charge happens, discounts combining, the summary families read,
 * Stripe's form encoding, and webhook signature checking.
 *
 *   node tests/test_stripe_rules.mjs
 */
import { createHmac } from 'node:crypto';
import { checker } from './_d1_fake.mjs';
import { firstCharge, combinePercent, chargeSummary, centralMidnight, placeStatusFor } from '../src/payments/stripe-billing.js';
import { formEncode, periodEnd, invoiceSubscription } from '../src/payments/stripe.js';
import { verifyStripeSignature } from '../src/payments/stripe-webhook.js';

const check = checker();
const at = (s) => Date.parse(s);
const unix = (s) => Math.floor(Date.parse(s) / 1000);

console.log('\n=== the 1st, Central ===');
// 1 November 2026 is the Sunday daylight saving ends, at 2 AM: midnight is still CDT.
check('midnight on Nov 1, 2026 is 05:00 UTC (still daylight time)', centralMidnight('2026-11-01') === unix('2026-11-01T05:00:00Z'));
check('midnight on Dec 1 is 06:00 UTC (standard time)', centralMidnight('2026-12-01') === unix('2026-12-01T06:00:00Z'));

console.log('\n=== a group already running: anchor on the next 1st ===');
let p = firstCharge({ nowMs: at('2026-10-25T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000 });
check('Stripe prorates from now to Nov 1, then bills each 1st', p.method === 'anchor' && p.anchor === unix('2026-11-01T05:00:00Z')
  && p.firstFull === '2026-11-01' && p.partialCents === 0, p);
p = firstCharge({ nowMs: at('2026-11-01T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000 });
check('joining on the 1st itself: anchor on the next 1st (nearly a full month, prorated)',
  p.method === 'anchor' && p.firstFull === '2026-12-01', p);

console.log('\n=== a group starting later: a trial to the 1st, plus the partial month we compute ===');
p = firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000 });
check('Oct 20 start: 12 of 31 days = $77.42 today, full fee from Nov 1', p.method === 'trial' && p.trialEnd === unix('2026-11-01T05:00:00Z')
  && p.partialCents === 7742 && p.partialFrom === '2026-10-20' && p.partialTo === '2026-10-31', p);
p = firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000, percentOff: 10 });
check('a sibling pays 10% less on the partial month too ($69.68)', p.partialCents === 6968, p.partialCents);
p = firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'place', startsOn: '2026-11-01', priceCents: 20000 });
check('a group starting on the 1st: no partial month', p.method === 'trial' && p.partialCents === 0 && p.firstFull === '2026-11-01', p);
p = firstCharge({ nowMs: at('2026-10-30T15:00:00Z'), purpose: 'place', startsOn: '2026-10-31', priceCents: 20000 });
check('the 1st under 48 hours away (Stripe\'s minimum trial): anchor instead', p.method === 'anchor' && p.firstFull === '2026-11-01', p);

console.log('\n=== moving from PayPal ===');
p = firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'move', paidThrough: '2026-11-14', priceCents: 20000 });
check('PayPal covers to Nov 14: nothing until Dec 1, no setup fee', p.method === 'trial' && p.trialEnd === unix('2026-12-01T06:00:00Z')
  && p.partialCents === 0 && p.firstFull === '2026-12-01', p);
p = firstCharge({ nowMs: at('2026-10-31T15:00:00Z'), purpose: 'move', paidThrough: '2026-10-31', priceCents: 20000 });
check('the 1st under 48 hours away: anchor with the first invoice waived', p.method === 'anchor_none'
  && p.anchor === unix('2026-11-01T05:00:00Z'), p);
p = firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'move', paidThrough: '2026-10-10', priceCents: 20000 });
check('PayPal already lapsed: the rest of this month is owed, from now', p.method === 'anchor' && p.firstFull === '2026-11-01', p);

console.log('\n=== discounts combine ===');
check('10% and 50% make 55%', combinePercent(10, 50) === 55);
check('10% alone, none, and a full scholarship', combinePercent(10) === 10 && combinePercent(0, 0) === 0 && combinePercent(10, 100) === 100);

console.log('\n=== what the family reads ===');
const place = { price_cents: 20000, setup_fee_cents: 4000 };
let lines = chargeSummary(place, firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000 }), 0,
  { nowMs: at('2026-10-15T15:00:00Z') });
check('later start: today the setup fee and the partial month; then $200 from November 1',
  lines[0] === 'Today: the $40 setup fee and $77.42 for 10/20–10/31.' && lines[1] === 'Then $200 on the 1st of each month, starting November 1.', lines);
lines = chargeSummary(place, firstCharge({ nowMs: at('2026-10-25T15:00:00Z'), purpose: 'place', startsOn: '2026-10-20', priceCents: 20000, percentOff: 10 }), 10,
  { nowMs: at('2026-10-25T15:00:00Z') });
check('running group with a sibling: setup fee and about the rest of the month; $180 after; says 10%',
  /^Today: the \$40 setup fee and about \$\d+(\.\d\d)? for the rest of this month\.$/.test(lines[0]) && lines[1].startsWith('Then $180 on the 1st')
  && lines[2] === 'That includes 10% off the monthly fee.', lines);
lines = chargeSummary(place, firstCharge({ nowMs: at('2026-10-15T15:00:00Z'), purpose: 'move', paidThrough: '2026-11-14', priceCents: 20000 }), 0,
  { purpose: 'move' });
check('moving: nothing today, $200 from December 1', lines[0] === 'Nothing today.' && lines[1] === 'Then $200 on the 1st of each month, starting December 1.', lines);

console.log('\n=== places follow Stripe ===');
check('active and trialing hold the place; past due, unpaid and paused are past due; canceled ends it',
  placeStatusFor('active') === 'active' && placeStatusFor('trialing') === 'active' && placeStatusFor('past_due') === 'past_due'
  && placeStatusFor('unpaid') === 'past_due' && placeStatusFor('paused') === 'past_due' && placeStatusFor('canceled') === 'ended'
  && placeStatusFor('incomplete') === null);
check('the period end comes from the items; the invoice\'s subscription from its parent',
  periodEnd({ items: { data: [{ current_period_end: 1795000000 }, { current_period_end: 1796000000 }] } }) === new Date(1796000000 * 1000).toISOString()
  && invoiceSubscription({ parent: { subscription_details: { subscription: 'sub_abc12345' } } }) === 'sub_abc12345'
  && invoiceSubscription({}) === null);

console.log('\n=== Stripe form encoding ===');
const enc = formEncode({ mode: 'subscription', line_items: [{ price_data: { currency: 'usd', recurring: { interval: 'month' } }, quantity: 1 }],
  metadata: { ref: 'a b' }, discounts: '', skip: null, payment_method_types: ['card', 'us_bank_account'] });
check('nested objects and arrays as a[0][b]=v, strings escaped, null left out', enc === [
  'mode=subscription', 'line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd',
  'line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month', 'line_items%5B0%5D%5Bquantity%5D=1',
  'metadata%5Bref%5D=a%20b', 'discounts=', 'payment_method_types%5B0%5D=card', 'payment_method_types%5B1%5D=us_bank_account'].join('&'), enc);

console.log('\n=== webhook signatures (Stripe\'s scheme) ===');
const secret = 'whsec_test_secret_value';
const body = new TextEncoder().encode('{"id":"evt_1","type":"invoice.paid"}');
const sign = (t, b = body, s = secret) => createHmac('sha256', s).update(`${t}.${new TextDecoder().decode(b)}`).digest('hex');
const now = 1800000000;
check('a good signature passes', (await verifyStripeSignature(`t=${now},v1=${sign(now)}`, body, secret, now)).ok);
check('one good among several v1 passes (Stripe signs with each live secret)',
  (await verifyStripeSignature(`t=${now},v1=${'0'.repeat(64)},v1=${sign(now)},v0=abc`, body, secret, now)).ok);
check('a changed body fails', !(await verifyStripeSignature(`t=${now},v1=${sign(now)}`, new TextEncoder().encode('{"id":"evt_2"}'), secret, now)).ok);
check('the wrong secret fails', !(await verifyStripeSignature(`t=${now},v1=${sign(now, body, 'whsec_other')}`, body, secret, now)).ok);
check('older than five minutes fails', (await verifyStripeSignature(`t=${now - 301},v1=${sign(now - 301)}`, body, secret, now)).reason === 'stale');
check('no header, or no v1, fails', (await verifyStripeSignature('', body, secret, now)).reason === 'header'
  && (await verifyStripeSignature(`t=${now}`, body, secret, now)).reason === 'header');

check.finish();
