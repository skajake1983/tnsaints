/**
 * Paying through Stripe: starting a checkout, and keeping places in step with
 * what Stripe says.
 *
 * THE OWNER'S RULES (2026-10-07 to 2026-10-18, plan "Stripe design"):
 *   - Every family is billed on the 1st (Central). A child joining mid-month
 *     pays the setup fee plus the rest of that month at sign-up.
 *   - A child whose group starts later pays from the group's first session.
 *   - A family moving from PayPal pays no setup fee and nothing until the 1st
 *     after the last day their PayPal payments cover.
 *   - 10% off the academy's monthly fee for each child after the first in a
 *     family (the earliest placed pays full); scholarships are a percentage
 *     set per place by an admin; the two combine (10% and 50% -> 55%).
 *   - Cancelling ends the place at the end of the paid month.
 *
 * HOW STRIPE DOES IT (verified in Stripe's docs, 2026-10-18):
 *   - Group running: billing_cycle_anchor = the next 1st. Stripe charges the
 *     rest of the month, prorated from the DISCOUNTED price, at checkout.
 *   - Group starting later: a trial to the 1st after the start, plus the
 *     partial month from the start as a one-time line we compute. Stripe
 *     wants a trial end at least 48 hours away and won't combine a trial with
 *     an anchor; closer than that, the running-group way (at most two days'
 *     difference).
 *   - Moving from PayPal: a trial to the 1st after the paid-through day; under
 *     48 hours, an anchor with prorations off (the first invoice is waived).
 *   - The sibling/scholarship coupon applies only to the program's own
 *     product, so the setup fee is never discounted.
 *
 * NOTHING IS TAKEN FROM THE BROWSER OR A WEBHOOK BODY: every change starts
 * from a fresh read of Stripe (stripe.js), and a checkout links to a place
 * only through its client_reference_id, the place's unguessable ref.
 */

import {
  stripeConfig, stripeRequest, fetchCheckoutSession, fetchSubscription, fetchInvoice, fetchCharge, periodEnd,
  invoiceSubscription, StripeError,
} from './stripe.js';
import { activateEnrollment } from './billing.js';
import { audit } from '../auth/staff.js';
import { centralToIso } from '../programs/manage.js';

const iso = () => new Date().toISOString();
const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;
const HOUR = 60 * 60 * 1000;
const TRIAL_MIN_MS = 48 * HOUR + 10 * 60 * 1000; // Stripe's 48 hours, plus a margin for the family's time on the page
export const SIBLING_PERCENT = 10;
const LIVE_SUB = `('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')`;

// --- dates, Central -----------------------------------------------------------------

export function centralDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/** "2026-10-20" -> "2026-11-01". */
export function firstOfNextMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function daysInMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Midnight Central at the start of `date`, as Unix seconds. */
export function centralMidnight(date) {
  return Math.floor(Date.parse(centralToIso(`${date}T00:00`)) / 1000);
}

/**
 * When and how the first charge happens. Pure, so the rules are tested
 * directly (tests/test_stripe_rules.mjs).
 *
 * @param {object} o
 * @param {number} o.nowMs
 * @param {'place'|'move'} o.purpose
 * @param {string|null} o.startsOn     the group's first session, YYYY-MM-DD
 * @param {string|null} o.paidThrough  moving from PayPal: the last day paid
 * @param {number} o.priceCents        the monthly fee before discount
 * @param {number} o.percentOff        combined discount, 0-100
 * @returns {{method: 'anchor'|'trial'|'anchor_none', anchor?: number, trialEnd?: number,
 *            firstFull: string, partialCents: number, partialFrom?: string, partialTo?: string}}
 */
export function firstCharge({ nowMs, purpose, startsOn = null, paidThrough = null, priceCents, percentOff = 0 }) {
  const today = centralDate(nowMs);
  const nowSec = Math.floor(nowMs / 1000);
  const net = (cents) => Math.round((cents * (100 - percentOff)) / 100);

  if (purpose === 'move' && /^\d{4}-\d{2}-\d{2}$/.test(String(paidThrough || '')) && paidThrough >= today) {
    const first = firstOfNextMonth(paidThrough);
    const at = centralMidnight(first);
    return at * 1000 - nowMs >= TRIAL_MIN_MS
      ? { method: 'trial', trialEnd: at, firstFull: first, partialCents: 0 }
      : { method: 'anchor_none', anchor: at, firstFull: first, partialCents: 0 };
  }

  const futureStart = /^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || '')) && startsOn > today;
  if (purpose === 'place' && futureStart) {
    const first = startsOn.endsWith('-01') ? startsOn : firstOfNextMonth(startsOn);
    const at = centralMidnight(first);
    if (at * 1000 - nowMs >= TRIAL_MIN_MS) {
      const days = startsOn.endsWith('-01') ? 0 : daysInMonth(startsOn) - Number(startsOn.slice(8)) + 1;
      const partial = days ? net(Math.round((priceCents * days) / daysInMonth(startsOn))) : 0;
      const to = new Date(Date.parse(`${first}T12:00:00Z`) - 24 * HOUR).toISOString().slice(0, 10);
      return { method: 'trial', trialEnd: at, firstFull: first, partialCents: partial, partialFrom: startsOn, partialTo: to };
    }
  }

  // Running (or about to start, or a lapsed PayPal payment): anchor on the next 1st.
  const first = firstOfNextMonth(today);
  const at = centralMidnight(first);
  return { method: 'anchor', anchor: Math.max(at, nowSec + 60), firstFull: first, partialCents: 0 };
}

/** 10% and 50% -> 55%. */
export function combinePercent(...parts) {
  const keep = parts.reduce((left, p) => (left * (100 - Math.min(100, Math.max(0, Number(p) || 0)))) / 100, 100);
  return Math.round(100 - keep);
}

// --- settings -----------------------------------------------------------------------

/** Which provider new payments use: 'paypal' (default) or 'stripe' (Admin -> Billing). */
export async function paymentsProvider(env) {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'payments.provider'`).first();
  return row?.value === 'stripe' ? 'stripe' : 'paypal';
}

export async function setPaymentsProvider(env, provider, actor) {
  if (!['paypal', 'stripe'].includes(provider)) return false;
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('payments.provider', ?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(provider, actor, iso()).run();
  return true;
}

// --- discounts ----------------------------------------------------------------------

/**
 * The combined percentage off for a place: a sibling discount when it is an
 * academy place and an earlier academy place in the family is live, plus the
 * place's scholarship.
 */
export async function percentOffFor(env, enrollment) {
  let sibling = 0;
  if (enrollment.program_id === 'academy') {
    const earlier = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM enrollments o
        WHERE o.household_id = ?1 AND o.program_id = 'academy' AND o.id != ?2 AND o.status IN ('active', 'past_due')
          AND (?3 IS NULL OR COALESCE(o.activated_at, o.created_at) < ?3 OR (COALESCE(o.activated_at, o.created_at) = ?3 AND o.id < ?2))`
    ).bind(enrollment.household_id, enrollment.id, enrollment.status === 'active' || enrollment.status === 'past_due'
      ? (enrollment.activated_at || enrollment.created_at) : null).first();
    if (Number(earlier?.n) > 0) sibling = SIBLING_PERCENT;
  }
  return combinePercent(sibling, enrollment.scholarship_percent || 0);
}

const coupons = new Map();

/** The coupon for `percent` off a product, created once (its id is deterministic). */
async function couponFor(config, productId, percent) {
  if (!percent) return null;
  const id = `tns_${productId}_${percent}pct`;
  const key = `${config.env}|${id}`;
  if (coupons.has(key)) return id;
  try {
    await stripeRequest(config, 'POST', '/v1/coupons', {
      id, percent_off: percent, duration: 'forever', name: `${percent}% off`, applies_to: { products: [productId] },
    }, { idempotencyKey: `coupon:${id}` });
  } catch (err) {
    // Already there (created earlier, or by a concurrent request): fine.
    if (!(err instanceof StripeError && err.code === 'resource_already_exists')) throw err;
  }
  coupons.set(key, true);
  return id;
}

// --- customers and products -------------------------------------------------------------

async function customerFor(env, config, householdId, accountId) {
  const row = await env.DB.prepare(
    `SELECT customer_id FROM stripe_customers WHERE household_id = ?1 AND environment = ?2`
  ).bind(householdId, config.env).first();
  if (row) return row.customer_id;
  const who = await env.DB.prepare(
    `SELECT a.email, a.display_name FROM accounts a WHERE a.id = ?1`
  ).bind(accountId).first();
  // The guardian's own name and email, for receipts. No child's name.
  const customer = await stripeRequest(config, 'POST', '/v1/customers', {
    email: who?.email || undefined, name: who?.display_name || undefined, metadata: { household: String(householdId) },
  }, { idempotencyKey: `customer:${config.env}:${householdId}` });
  await env.DB.prepare(
    `INSERT INTO stripe_customers (household_id, environment, customer_id, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (household_id, environment) DO NOTHING`
  ).bind(householdId, config.env, customer.id, iso()).run();
  const stored = await env.DB.prepare(
    `SELECT customer_id FROM stripe_customers WHERE household_id = ?1 AND environment = ?2`
  ).bind(householdId, config.env).first();
  return stored.customer_id;
}

async function productFor(env, config, program) {
  if (program[config.productColumn]) return program[config.productColumn];
  const product = await stripeRequest(config, 'POST', '/v1/products', {
    name: program.name, metadata: { program: program.id },
  }, { idempotencyKey: `product:${config.env}:${program.id}` });
  await env.DB.prepare(
    `UPDATE programs SET ${config.productColumn} = ?2 WHERE id = ?1 AND ${config.productColumn} IS NULL`
  ).bind(program.id, product.id).run();
  const stored = await env.DB.prepare(`SELECT ${config.productColumn} AS p FROM programs WHERE id = ?1`).bind(program.id).first();
  return stored.p;
}

// --- starting a checkout --------------------------------------------------------------------

/** The place, with everything a checkout needs, if it is this account's. */
export async function placeForAccount(env, accountId, ref) {
  return env.DB.prepare(
    `SELECT e.id, e.ref, e.status, e.household_id, e.program_id, e.offer_expires_at, e.activated_at, e.created_at,
            e.scholarship_percent, e.billed_outside, e.outside_paid_through, e.consent_record_id,
            p.display_name AS child_name,
            pr.name AS program_name, pr.billing, pr.price_cents, pr.setup_fee_cents, pr.enrollment_mode,
            pr.stripe_product_sandbox, pr.stripe_product_live,
            g.name AS group_name, g.schedule_summary, g.location, g.starts_on
       FROM enrollments e
       JOIN players p ON p.id = e.player_id
       JOIN programs pr ON pr.id = e.program_id
       LEFT JOIN program_groups g ON g.id = e.group_id
      WHERE e.ref = ?2 AND e.household_id IN (${MEMBER_OF})`
  ).bind(accountId, ref).first();
}

/** Does this place already have a live Stripe subscription? */
export async function liveSubscriptionFor(env, enrollmentId) {
  return env.DB.prepare(
    `SELECT subscription_id, status, cancel_at_period_end, current_period_end FROM stripe_subscriptions
      WHERE enrollment_id = ?1 AND status IN ${LIVE_SUB}`
  ).bind(enrollmentId).first();
}

/**
 * What the family will be charged, in words, for the pay page. The anchor
 * case is Stripe's prorated amount, so it is "about".
 */
export function chargeSummary(place, plan, percentOff, { nowMs = Date.now(), purpose = 'place' } = {}) {
  const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
  const monthly = Math.round((place.price_cents * (100 - percentOff)) / 100);
  const firstFull = new Date(`${plan.firstFull}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
  const lines = [];
  const setup = purpose === 'place' && place.setup_fee_cents ? place.setup_fee_cents : 0;
  if (plan.method === 'trial' && purpose === 'place') {
    const today = [setup ? `the ${money(setup)} setup fee` : '', plan.partialCents
      ? `${money(plan.partialCents)} for ${plan.partialFrom.slice(5).replace('-', '/')}–${plan.partialTo.slice(5).replace('-', '/')}` : '']
      .filter(Boolean);
    if (today.length) lines.push(`Today: ${today.join(' and ')}.`);
  } else if (plan.method === 'anchor') {
    const seconds = plan.anchor - Math.floor(nowMs / 1000);
    const part = Math.round((monthly * seconds) / (daysInMonth(centralDate(nowMs)) * 86400));
    lines.push(`Today: ${setup ? `the ${money(setup)} setup fee and ` : ''}about ${money(part)} for the rest of this month.`);
  } else {
    lines.push('Nothing today.');
  }
  lines.push(`Then ${money(monthly)} on the 1st of each month, starting ${firstFull}.`);
  if (percentOff) lines.push(`That includes ${percentOff}% off the monthly fee.`);
  return lines;
}

/**
 * Start Stripe Checkout for a place: paying for an offer ('place'), moving an
 * existing place from PayPal ('move'), or a one-time program.
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: string}>}
 */
export async function startCheckout(env, accountId, ref, { purpose, origin, base = '' }) {
  const config = stripeConfig(env);
  const place = await placeForAccount(env, accountId, ref);
  if (!place) return { ok: false, reason: 'not-found' };
  if (await liveSubscriptionFor(env, place.id)) return { ok: false, reason: 'already' };

  const nowMs = Date.now();
  let expiresMs = nowMs + 24 * HOUR;
  if (purpose === 'move') {
    if (!['active', 'past_due'].includes(place.status) || place.billed_outside !== 'paypal_join' || !place.outside_paid_through) {
      return { ok: false, reason: 'not-movable' };
    }
  } else {
    if (place.status !== 'offered' || !place.offer_expires_at || Date.parse(place.offer_expires_at) <= nowMs) {
      return { ok: false, reason: 'not-offered' };
    }
    // Stripe: a session lives 30 minutes to 24 hours.
    expiresMs = Math.min(expiresMs, Math.max(Date.parse(place.offer_expires_at), nowMs + 31 * 60 * 1000));
  }
  if (!place.price_cents || (place.billing !== 'subscription' && place.billing !== 'one_time')) {
    return { ok: false, reason: 'not-payable' };
  }

  const program = { ...place, id: place.program_id, name: place.program_name };
  const [customer, product] = await Promise.all([
    customerFor(env, config, place.household_id, accountId),
    productFor(env, config, program),
  ]);
  const doneUrl = `${origin}${base}/pay/${ref}/done?session_id={CHECKOUT_SESSION_ID}`;
  const backUrl = `${origin}${base}${purpose === 'move' ? `/pay/${ref}/move` : `/pay/${ref}`}`;
  const common = {
    customer, client_reference_id: ref, metadata: { ref, purpose },
    success_url: doneUrl, cancel_url: backUrl, expires_at: Math.floor(expiresMs / 1000),
    payment_method_types: ['card', 'us_bank_account'],
  };

  let params;
  if (place.billing === 'one_time') {
    params = {
      ...common, mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', product, unit_amount: place.price_cents }, quantity: 1 }],
      payment_intent_data: { description: place.program_name, metadata: { ref } },
    };
  } else {
    const percentOff = await percentOffFor(env, place);
    const coupon = await couponFor(config, product, percentOff);
    const plan = firstCharge({ nowMs, purpose, startsOn: place.starts_on, paidThrough: place.outside_paid_through,
      priceCents: place.price_cents, percentOff });
    const lines = [{ price_data: { currency: 'usd', product, unit_amount: place.price_cents, recurring: { interval: 'month' } }, quantity: 1 }];
    if (purpose === 'place' && place.setup_fee_cents) {
      lines.push({ price_data: { currency: 'usd', product_data: { name: 'Setup fee (practice shirt)' }, unit_amount: place.setup_fee_cents }, quantity: 1 });
    }
    if (plan.partialCents) {
      // Already discounted; its own product, so the coupon does not discount it again.
      lines.push({ price_data: { currency: 'usd', product_data: { name: `${place.program_name}, ${plan.partialFrom} to ${plan.partialTo}` },
        unit_amount: plan.partialCents }, quantity: 1 });
    }
    const subscriptionData = { metadata: { ref, purpose }, description: `${place.program_name}: ${place.group_name || ''}`.slice(0, 500) };
    if (plan.method === 'trial') subscriptionData.trial_end = plan.trialEnd;
    else subscriptionData.billing_cycle_anchor = plan.anchor;
    if (plan.method === 'anchor_none') subscriptionData.proration_behavior = 'none';
    params = { ...common, mode: 'subscription', line_items: lines, subscription_data: subscriptionData,
      discounts: coupon ? [{ coupon }] : undefined };
  }

  const session = await stripeRequest(config, 'POST', '/v1/checkout/sessions', params);
  await env.DB.prepare(
    `INSERT INTO stripe_checkouts (session_id, environment, enrollment_id, household_id, purpose, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(session.id, config.env, place.id, place.household_id, place.billing === 'one_time' ? 'one_time' : purpose,
    `account:${accountId}`, iso()).run();
  return { ok: true, url: session.url };
}

// --- finishing a checkout ---------------------------------------------------------------------

async function flagNoSeat(env, enrollmentId, sessionId) {
  console.error(JSON.stringify({ event: 'billing_paid_without_seat', enrollment: enrollmentId, provider: 'stripe' }));
  await audit(env, {
    actor: 'system:stripe', action: 'billing.paid_without_seat', subjectType: 'enrollment', subjectId: enrollmentId,
    detail: { checkout: sessionId },
  });
}

/**
 * Bring a Checkout Session's place in line with Stripe. From the family's
 * return (accountId given: the place must be theirs), the webhook or the sweep.
 * @returns {Promise<{ok: boolean, reason?: string, status?: string}>}
 */
export async function syncCheckout(env, sessionId, { accountId = null } = {}) {
  const config = stripeConfig(env);
  const known = await env.DB.prepare(
    `SELECT c.session_id, c.enrollment_id, c.household_id, c.purpose, c.status, e.ref, e.status AS place_status
       FROM stripe_checkouts c JOIN enrollments e ON e.id = c.enrollment_id
      WHERE c.session_id = ?1 AND c.environment = ?2`
  ).bind(sessionId, config.env).first();
  if (!known) return { ok: false, reason: 'unknown' };
  if (accountId !== null) {
    const mine = await env.DB.prepare(`SELECT 1 AS ok FROM household_members WHERE account_id = ?1 AND household_id = ?2`)
      .bind(accountId, known.household_id).first();
    if (!mine) return { ok: false, reason: 'unknown' };
  }
  const session = await fetchCheckoutSession(config, sessionId);
  if (!session || session.client_reference_id !== known.ref) return { ok: false, reason: 'mismatch' };
  if (session.status === 'expired') {
    await env.DB.prepare(`UPDATE stripe_checkouts SET status = 'expired' WHERE session_id = ?1 AND status = 'open'`).bind(sessionId).run();
    return { ok: true, status: 'expired' };
  }
  if (session.status !== 'complete') return { ok: true, status: 'open' };

  await env.DB.prepare(
    `UPDATE stripe_checkouts SET status = 'complete', completed_at = COALESCE(completed_at, ?2) WHERE session_id = ?1`
  ).bind(sessionId, iso()).run();

  if (session.mode === 'subscription' && session.subscription) {
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    await recordSubscription(env, config, subId, known);
  }
  if (session.mode === 'payment' && session.payment_status === 'paid') {
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (pi) {
      await env.DB.prepare(
        `INSERT INTO payments (paypal_transaction_id, environment, provider, enrollment_id, household_id, amount_cents, currency,
                               kind, status, paid_at, created_at)
         VALUES (?1, ?2, 'stripe', ?3, ?4, ?5, ?6, 'one_time', 'paid', ?7, ?7)
         ON CONFLICT (environment, paypal_transaction_id) DO NOTHING`
      ).bind(pi, config.env, known.enrollment_id, known.household_id, Number(session.amount_total) || 0,
        String(session.currency || 'usd').toUpperCase(), iso()).run();
    }
  }

  // The place: a move keeps its place; a new place is activated (re-checking the seat).
  if (known.purpose !== 'move' && known.place_status === 'offered') {
    if (!(await activateEnrollment(env, known.enrollment_id))) {
      await flagNoSeat(env, known.enrollment_id, sessionId);
      return { ok: false, reason: 'no-seat' };
    }
  }
  await syncDiscounts(env, known.household_id);
  return { ok: true, status: 'complete' };
}

// --- subscriptions --------------------------------------------------------------------------

/** What a Stripe subscription status means for a place, or null for "no change". */
export function placeStatusFor(status) {
  if (status === 'active' || status === 'trialing') return 'active';
  if (status === 'past_due' || status === 'unpaid' || status === 'paused') return 'past_due';
  if (status === 'canceled' || status === 'incomplete_expired') return 'ended';
  return null;
}

async function recordSubscription(env, config, subscriptionId, link = null) {
  const sub = await fetchSubscription(config, subscriptionId);
  if (!sub) return null;
  const now = iso();
  const ref = String(sub.metadata?.ref || '');
  let enrollmentId = link?.enrollment_id ?? null;
  let householdId = link?.household_id ?? null;
  if (!enrollmentId && ref) {
    const e = await env.DB.prepare(`SELECT id, household_id FROM enrollments WHERE ref = ?1`).bind(ref).first();
    if (e) { enrollmentId = e.id; householdId = e.household_id; }
  }
  await env.DB.prepare(
    `INSERT INTO stripe_subscriptions (subscription_id, environment, enrollment_id, household_id, customer_id, status,
                                       cancel_at_period_end, current_period_end, last_synced_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)
     ON CONFLICT (environment, subscription_id) DO UPDATE SET
       enrollment_id = COALESCE(stripe_subscriptions.enrollment_id, excluded.enrollment_id),
       household_id = COALESCE(stripe_subscriptions.household_id, excluded.household_id),
       customer_id = excluded.customer_id, status = excluded.status,
       cancel_at_period_end = excluded.cancel_at_period_end, current_period_end = excluded.current_period_end,
       last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`
  ).bind(sub.id, config.env, enrollmentId, householdId, typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null,
    String(sub.status || 'unknown'), sub.cancel_at_period_end ? 1 : 0, periodEnd(sub), now).run();
  return { sub, enrollmentId, householdId };
}

/**
 * Re-read a subscription and move its place: active/trialing -> active (from
 * past due), past due/unpaid/paused -> past due, canceled -> ended.
 */
export async function syncSubscription(env, subscriptionId) {
  const config = stripeConfig(env);
  const got = await recordSubscription(env, config, subscriptionId);
  if (!got) return { ok: false, reason: 'unknown' };
  const { sub, enrollmentId, householdId } = got;
  if (!enrollmentId) return { ok: true, reason: 'unlinked' };
  const target = placeStatusFor(sub.status);
  const now = iso();
  if (target === 'active') {
    // Only from past due here; a new place is activated when its checkout completes.
    await env.DB.prepare(`UPDATE enrollments SET status = 'active', updated_at = ?2 WHERE id = ?1 AND status = 'past_due'`)
      .bind(enrollmentId, now).run();
  } else if (target === 'past_due') {
    await env.DB.prepare(`UPDATE enrollments SET status = 'past_due', updated_at = ?2 WHERE id = ?1 AND status = 'active'`)
      .bind(enrollmentId, now).run();
  } else if (target === 'ended' && sub.status === 'canceled') {
    await env.DB.prepare(
      `UPDATE enrollments SET status = 'ended', ended_at = ?2, updated_at = ?2 WHERE id = ?1 AND status IN ('active', 'past_due')`
    ).bind(enrollmentId, now).run();
  }
  if (householdId) await syncDiscounts(env, householdId);
  return { ok: true, enrollmentId, status: sub.status };
}

/**
 * Keep each academy subscription's discount right: the family's earliest
 * academy place pays full; every later one gets the sibling 10%; each adds its
 * scholarship. Called whenever a family's places or subscriptions change.
 * Changing a discount affects future invoices only (Stripe).
 */
export async function syncDiscounts(env, householdId) {
  const config = stripeConfig(env);
  const { results } = await env.DB.prepare(
    `SELECT s.subscription_id, s.coupon_id, e.id, e.program_id, e.household_id, e.status, e.activated_at, e.created_at,
            e.scholarship_percent, pr.${config.productColumn} AS product
       FROM stripe_subscriptions s
       JOIN enrollments e ON e.id = s.enrollment_id
       JOIN programs pr ON pr.id = e.program_id
      WHERE s.household_id = ?1 AND s.environment = ?2 AND s.status IN ${LIVE_SUB} AND pr.billing = 'subscription'`
  ).bind(householdId, config.env).all();
  for (const row of results || []) {
    if (!row.product) continue;
    const coupon = await couponFor(config, row.product, await percentOffFor(env, row));
    if ((coupon || null) === (row.coupon_id || null)) continue;
    await stripeRequest(config, 'POST', `/v1/subscriptions/${row.subscription_id}`,
      { discounts: coupon ? [{ coupon }] : '' });
    await env.DB.prepare(`UPDATE stripe_subscriptions SET coupon_id = ?2, updated_at = ?3 WHERE subscription_id = ?1 AND environment = ?4`)
      .bind(row.subscription_id, coupon, iso(), config.env).run();
  }
}

// --- payments -----------------------------------------------------------------------------------

/**
 * Record a paid invoice. A subscription's first invoice is split: the setup
 * fee (the program's, when the place was paid for here) and the tuition.
 */
export async function recordInvoice(env, invoiceId) {
  const config = stripeConfig(env);
  const invoice = await fetchInvoice(config, invoiceId);
  if (!invoice) return { ok: false, reason: 'unknown' };
  const subscriptionId = invoiceSubscription(invoice);
  if (invoice.status !== 'paid') return { ok: true, subscriptionId, reason: 'unpaid' };
  const link = subscriptionId
    ? await env.DB.prepare(
      `SELECT s.enrollment_id, s.household_id, pr.setup_fee_cents, pr.${config.productColumn} AS product,
              (SELECT purpose FROM stripe_checkouts c WHERE c.enrollment_id = s.enrollment_id AND c.status = 'complete'
                ORDER BY c.created_at DESC LIMIT 1) AS purpose
         FROM stripe_subscriptions s LEFT JOIN enrollments e ON e.id = s.enrollment_id LEFT JOIN programs pr ON pr.id = e.program_id
        WHERE s.environment = ?1 AND s.subscription_id = ?2`
    ).bind(config.env, subscriptionId).first()
    : null;
  const paid = Number(invoice.amount_paid) || 0;
  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : iso();
  const currency = String(invoice.currency || 'usd').toUpperCase();
  let setup = 0;
  if (invoice.billing_reason === 'subscription_create' && link?.purpose === 'place' && link.setup_fee_cents) {
    const hasSetupLine = (invoice.lines?.data || []).some((l) =>
      l.pricing?.price_details?.product !== link.product && Number(l.amount) === Number(link.setup_fee_cents));
    if (hasSetupLine) setup = Math.min(paid, Number(link.setup_fee_cents));
  }
  const rows = [];
  if (setup) rows.push([`${invoice.id}:setup`, setup, 'setup_fee']);
  if (paid - setup > 0) rows.push([invoice.id, paid - setup, 'recurring']);
  for (const [id, cents, kind] of rows) {
    await env.DB.prepare(
      `INSERT INTO payments (paypal_transaction_id, environment, provider, enrollment_id, household_id, amount_cents, currency,
                             kind, status, paid_at, created_at)
       VALUES (?1, ?2, 'stripe', ?3, ?4, ?5, ?6, ?7, 'paid', ?8, ?9)
       ON CONFLICT (environment, paypal_transaction_id) DO NOTHING`
    ).bind(id, config.env, link?.enrollment_id ?? null, link?.household_id ?? null, cents, currency, kind, paidAt, iso()).run();
  }
  return { ok: true, subscriptionId };
}

/** Record a refund (cumulative per charge), against the family that paid. */
export async function recordRefund(env, chargeId) {
  const config = stripeConfig(env);
  const charge = await fetchCharge(config, chargeId);
  if (!charge || !Number(charge.amount_refunded)) return { ok: false, reason: 'unknown' };
  const customer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  const family = customer
    ? await env.DB.prepare(`SELECT household_id FROM stripe_customers WHERE environment = ?1 AND customer_id = ?2`).bind(config.env, customer).first()
    : null;
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO payments (paypal_transaction_id, environment, provider, household_id, amount_cents, currency, kind, status, paid_at, created_at)
     VALUES (?1, ?2, 'stripe', ?3, ?4, ?5, 'refund', 'refunded', ?6, ?6)
     ON CONFLICT (environment, paypal_transaction_id) DO UPDATE SET amount_cents = excluded.amount_cents`
  ).bind(`${charge.id}:refund`, config.env, family?.household_id ?? null, -Number(charge.amount_refunded),
    String(charge.currency || 'usd').toUpperCase(), now).run();
  return { ok: true };
}

// --- the family's own billing page ------------------------------------------------------------

/** Stripe's customer portal (card or bank, receipts, cancel at the end of the paid month). */
export async function portalUrl(env, accountId, returnUrl) {
  const config = stripeConfig(env);
  const row = await env.DB.prepare(
    `SELECT c.customer_id FROM stripe_customers c WHERE c.environment = ?2 AND c.household_id IN (${MEMBER_OF}) LIMIT 1`
  ).bind(accountId, config.env).first();
  if (!row) return null;
  const key = `stripe.portal_config.${config.env}`;
  let conf = (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?1`).bind(key).first())?.value;
  if (!conf) {
    const created = await stripeRequest(config, 'POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: 'Tennessee Saints Basketball Academy' },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: { enabled: false },
        customer_update: { enabled: false },
      },
    }, { idempotencyKey: `portal-config:${config.env}:v1` });
    conf = created.id;
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, 'system:stripe', ?3)
       ON CONFLICT (key) DO NOTHING`
    ).bind(key, conf, iso()).run();
  }
  const session = await stripeRequest(config, 'POST', '/v1/billing_portal/sessions', {
    customer: row.customer_id, return_url: returnUrl, configuration: conf,
  });
  return session.url;
}

// --- the hourly sweep -----------------------------------------------------------------------

/**
 * Finish checkouts a family never came back from (closed the tab), and
 * re-read the subscriptions we have heard least about. Bounded.
 */
export async function sweepStripe(env, { checkouts = 3, subscriptions = 3 } = {}) {
  const config = stripeConfig(env);
  if (!config.secretKey) return 0;
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [open, stale] = await env.DB.batch([
    env.DB.prepare(
      `SELECT session_id FROM stripe_checkouts WHERE environment = ?1 AND status = 'open' AND created_at <= ?2
        ORDER BY created_at LIMIT ?3`
    ).bind(config.env, tenMinutesAgo, checkouts),
    env.DB.prepare(
      `SELECT subscription_id FROM stripe_subscriptions WHERE environment = ?1 AND status IN ${LIVE_SUB}
        ORDER BY last_synced_at IS NOT NULL, last_synced_at LIMIT ?2`
    ).bind(config.env, subscriptions),
  ]);
  let n = 0;
  for (const r of open.results || []) {
    try { await syncCheckout(env, r.session_id); n += 1; } catch (err) {
      console.error(JSON.stringify({ event: 'stripe_sweep_failed', what: 'checkout', message: err?.message }));
    }
  }
  for (const r of stale.results || []) {
    try { await syncSubscription(env, r.subscription_id); n += 1; } catch (err) {
      console.error(JSON.stringify({ event: 'stripe_sweep_failed', what: 'subscription', message: err?.message }));
    }
  }
  return n;
}
