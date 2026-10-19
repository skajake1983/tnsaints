/**
 * Accepting an offered place: the pay page and its confirmation.
 *
 * Monthly programs (PayPal subscriptions):
 *   GET  /pay/:ref             the offer, and PayPal's subscription button
 *   POST /pay/:ref/approved    { subscription_id } from the button, checked with PayPal
 * One-time programs (PayPal Orders, payments/orders.js):
 *   GET  /pay/:ref             the offer, and PayPal's pay button
 *   POST /pay/:ref/order       the Worker creates the order (amount from the program)
 *   POST /pay/:ref/captured    { order_id } — the Worker checks and captures it
 * Free programs:
 *   GET  /pay/:ref             the offer, and an "Accept the place" button
 *   POST /pay/:ref/accept      confirms it (self-serve free sign-ups never come here:
 *                              they are confirmed when signed up)
 *
 * When Admin -> Billing says new payments use Stripe (payments/stripe-billing.js):
 *   GET  /pay/:ref             the offer, what will be charged when, and a button
 *   POST /pay/:ref/checkout    creates a Stripe Checkout Session; 303 to Stripe's page
 *   GET  /pay/:ref/done        Stripe sends the family back here; checked with Stripe
 *   GET  /pay/:ref/move        a place paid through the old Join page: move to Stripe
 *   POST /pay/:ref/move        creates that Checkout Session
 *   GET  /billing/manage       303 to Stripe's billing page (card or bank, receipts, cancel)
 * Card and bank details are entered on Stripe's own pages, never here.
 *
 * The page exists only while this family's offer is live, so paying for a
 * place that has no seat and no schedule is not possible from here (the
 * owner's rule). PayPal is sent the enrollment's unguessable ref as
 * custom_id — never a child's name.
 *
 * The button is PayPal's JavaScript SDK. This page alone loads it: its CSP
 * allows PayPal's hosts plus a per-response nonce for the one inline script,
 * and COOP is relaxed to same-origin-allow-popups so PayPal's window can talk
 * back. The inline scripts are static; everything they need comes from data-
 * attributes, never interpolated into code.
 */

import { esc, portalPage, portalResponse, notFoundResponse } from './ui.js';
import { redirect } from './auth-pages.js';
import { randomToken } from '../lib/crypto.js';
import { readJson, BodyTooLarge } from '../lib/body.js';
import { json } from '../http.js';
import { audit } from '../auth/staff.js';
import { paypalConfig, paypalConfigured } from '../payments/paypal.js';
import { approveFromPortal, activateEnrollment } from '../payments/billing.js';
import { createOrderForPortal, captureForPortal } from '../payments/orders.js';
import { priceLine, enrollmentEnabled } from '../programs/enrollment.js';
import { stripeConfigured } from '../payments/stripe.js';
import { portalOrigin } from '../auth/magic.js';
import {
  paymentsProvider, placeForAccount, firstCharge, percentOffFor, chargeSummary, startCheckout, syncCheckout,
  liveSubscriptionFor, portalUrl,
} from '../payments/stripe-billing.js';

const NAV = [{ href: '/', label: 'Family' }, { href: '/programs', label: 'Programs' }, { href: '/account', label: 'Account' }];
const REF = /^[A-Za-z0-9_-]{16,43}$/;
const SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,40}$/;
const ORDER_ID = /^[A-Z0-9]{10,40}$/;

const PAY_SCRIPT = `(function () {
  var box = document.getElementById('paypal-button');
  var status = document.getElementById('pay-status');
  function say(t) { status.textContent = t; }
  if (!box) return;
  if (!window.paypal || !window.paypal.Buttons) {
    say('The PayPal button could not load. Check your connection and reload, or email info@tnsaints.com.');
    return;
  }
  window.paypal.Buttons({
    style: { layout: 'vertical', label: 'subscribe' },
    createSubscription: function (data, actions) {
      var sub = {
        plan_id: box.dataset.plan,
        custom_id: box.dataset.ref,
        application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', brand_name: 'Tennessee Saints' }
      };
      if (box.dataset.start) sub.start_time = box.dataset.start;
      return actions.subscription.create(sub);
    },
    onApprove: function (data) {
      say('Confirming with PayPal...');
      return fetch(box.dataset.approve, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription_id: data.subscriptionID })
      }).then(function (r) { return r.json(); }).then(function (b) {
        if (b.ok) { location.assign(b.redirect); return; }
        say(b.error || 'We could not confirm the payment. Please email info@tnsaints.com.');
      }).catch(function () {
        say('We could not confirm the payment yet. If PayPal shows it as complete, it will appear on your family page shortly.');
      });
    },
    onError: function () { say('PayPal could not start the payment. Please try again.'); }
  }).render('#paypal-button');
})();`;

const ORDER_SCRIPT = `(function () {
  var box = document.getElementById('paypal-button');
  var status = document.getElementById('pay-status');
  function say(t) { status.textContent = t; }
  if (!box) return;
  if (!window.paypal || !window.paypal.Buttons) {
    say('The PayPal button could not load. Check your connection and reload, or email info@tnsaints.com.');
    return;
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  window.paypal.Buttons({
    style: { layout: 'vertical', label: 'pay' },
    createOrder: function () {
      return post(box.dataset.create).then(function (b) {
        if (b.ok) return b.order_id;
        say(b.error || 'PayPal could not start the payment. Please try again.');
        throw new Error('order');
      });
    },
    onApprove: function (data) {
      say('Confirming with PayPal...');
      return post(box.dataset.capture, { order_id: data.orderID }).then(function (b) {
        if (b.ok) { location.assign(b.redirect); return; }
        say(b.error || 'We could not confirm the payment. Please email info@tnsaints.com.');
      }).catch(function () {
        say('We could not confirm the payment yet. If PayPal shows it as complete, it will appear on your family page shortly.');
      });
    },
    onError: function () { say('PayPal could not start the payment. Please try again.'); }
  }).render('#paypal-button');
})();`;

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;

async function loadOffer(env, accountId, ref, planColumn) {
  return env.DB.prepare(
    `SELECT e.id, e.ref, e.status, e.offer_expires_at, p.display_name AS child_name,
            pr.id AS program_id, pr.name AS program_name, pr.billing, pr.price_cents, pr.setup_fee_cents,
            pr.enrollment_mode, pr.${planColumn} AS plan_id,
            g.name AS group_name, g.schedule_summary, g.location, g.starts_on
       FROM enrollments e
       JOIN players p ON p.id = e.player_id
       JOIN programs pr ON pr.id = e.program_id
       LEFT JOIN program_groups g ON g.id = e.group_id
      WHERE e.ref = ?2 AND e.household_id IN (${MEMBER_OF})`
  )
    .bind(accountId, ref)
    .first();
}

function page(rc, title, body, { status = 200, headers = {} } = {}) {
  return portalResponse(portalPage({ rc, title, body, nav: NAV, current: '/', signedIn: true }), { status, headers });
}

function message(rc, title, text, status = 200) {
  return page(rc, title, `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>${esc(title)}</h1><p class="lede">${esc(text)}</p>`, { status });
}

const longDate = (value) =>
  new Date(value).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' });
const holdUntil = (value) =>
  new Date(value).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

/** The subscription's first billing date: the group's first session, if it is still ahead. */
function startTime(startsOn, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || ''))) return '';
  const at = Date.parse(`${startsOn}T14:00:00Z`); // 8 or 9 AM Central
  return at > now + 24 * 60 * 60 * 1000 ? new Date(at).toISOString().replace('.000', '') : '';
}

function placeTable(offer, { cost = true } = {}) {
  const row = (label, value) => `<tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `<section class="panel" aria-label="The place">
  <table style="border-collapse:collapse">
    ${row('Program', offer.program_name)}
    ${row('Group', offer.group_name)}
    ${row('When', offer.schedule_summary)}
    ${offer.location ? row('Where', offer.location) : ''}
    ${offer.starts_on ? row('First session', longDate(`${offer.starts_on}T17:00:00Z`)) : ''}
    ${cost ? row('Cost', priceLine(offer)) : ''}
  </table>
</section>`;
}

function payResponse(rc, body, nonce) {
  const csp =
    "default-src 'none'; " +
    `script-src 'nonce-${nonce}' https://www.paypal.com https://*.paypal.com https://*.paypalobjects.com; ` +
    "connect-src 'self' https://*.paypal.com; frame-src https://*.paypal.com; " +
    "img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com; style-src 'unsafe-inline'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  return page(rc, 'Accept the place', body, {
    headers: {
      'Content-Security-Policy': csp,
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=(), payment=(self "https://www.paypal.com" "https://www.sandbox.paypal.com")',
    },
  });
}

function heldLine(offer) {
  return offer.enrollment_mode === 'self_serve'
    ? `A place is being held for ${offer.child_name} until ${holdUntil(offer.offer_expires_at)} — finish paying before then.`
    : `A place is being held for ${offer.child_name} until ${longDate(offer.offer_expires_at)}.`;
}

async function subscriptionPage(rc, offer, config) {
  const nonce = randomToken(16);
  const start = startTime(offer.starts_on);
  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Accept the place</h1>
<p class="lede">${esc(heldLine(offer))}</p>
${placeTable(offer)}
<section class="panel" aria-labelledby="pp-h">
  <h2 id="pp-h" style="margin-top:0">Pay with PayPal</h2>
  <p>${offer.setup_fee_cents ? 'The one-time setup fee is charged today. ' : ''}${start
    ? 'Monthly payments start on the first session.' : 'Monthly payments start today.'} You can manage the subscription from your PayPal account.</p>
  <div id="paypal-button" data-plan="${esc(offer.plan_id)}" data-ref="${esc(offer.ref)}"
       data-approve="${esc(rc.url(`/pay/${offer.ref}/approved`))}"${start ? ` data-start="${esc(start)}"` : ''}></div>
  <p id="pay-status" role="status" aria-live="polite"></p>
</section>
<script nonce="${nonce}" src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&vault=true&intent=subscription"></script>
<script nonce="${nonce}">${PAY_SCRIPT}</script>`;
  return payResponse(rc, body, nonce);
}

async function orderPage(rc, offer, config) {
  const nonce = randomToken(16);
  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Accept the place</h1>
<p class="lede">${esc(heldLine(offer))}</p>
${placeTable(offer)}
<section class="panel" aria-labelledby="pp-h">
  <h2 id="pp-h" style="margin-top:0">Pay with PayPal</h2>
  <p>One payment. PayPal shows the program, never your child's name.</p>
  <div id="paypal-button" data-create="${esc(rc.url(`/pay/${offer.ref}/order`))}"
       data-capture="${esc(rc.url(`/pay/${offer.ref}/captured`))}"></div>
  <p id="pay-status" role="status" aria-live="polite"></p>
</section>
<script nonce="${nonce}" src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=capture"></script>
<script nonce="${nonce}">${ORDER_SCRIPT}</script>`;
  return payResponse(rc, body, nonce);
}

/** The pay page when payments go through Stripe: what is charged when, and one button. */
function stripePayPage(rc, offer, summary, action, heading = 'Accept the place', lede = heldLine(offer), { cost = true } = {}) {
  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>${esc(heading)}</h1>
<p class="lede">${esc(lede)}</p>
${placeTable(offer, { cost })}
<section class="panel" aria-labelledby="pay-h">
  <h2 id="pay-h" style="margin-top:0">Payment</h2>
  ${summary.map((l) => `<p>${esc(l)}</p>`).join('')}
  <p class="hint">You pay on Stripe's secure page, by card or from your bank account. Stripe shows the program, never your
  child's name. You can change your card or bank, see receipts, or cancel at any time from your family page; cancelling ends
  the place at the end of the month you've paid for.</p>
  <form method="post" action="${esc(action)}"><button class="btn" type="submit">Continue to secure payment</button></form>
</section>`;
  // The button's form posts here and is redirected on to Stripe's checkout page,
  // which the form-action directive has to allow.
  return page(rc, heading, body, {
    headers: {
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; " +
        "frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const STRIPE_ERRORS = {
  'not-found': ["We couldn't find that place", "If you think this is a mistake, email info@tnsaints.com.", 404],
  already: ["You're all set", 'Payment for this place is already set up. You can manage it from your family page.', 409],
  'not-offered': ['This offer has ended', 'The time to accept this place has passed.', 410],
  'not-movable': ['Nothing to move', 'This place is not paid through the old Join page, or we still need the date your PayPal payments cover. Email info@tnsaints.com and we will help.', 409],
  'not-payable': ['Payments are not set up yet', 'Please try again later, or email info@tnsaints.com and we will help.', 503],
};

function seeOtherExternal(url) {
  return new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

const APPROVE_ERRORS = {
  'not-found': "We couldn't find that place.",
  unknown: "PayPal doesn't know that subscription yet. If you just paid, wait a minute and refresh your family page.",
  mismatch: "That PayPal subscription doesn't match this place, so we didn't apply it. Please email info@tnsaints.com.",
  taken: 'That PayPal subscription is already in use for another place. Please email info@tnsaints.com.',
  'no-seat': "Your payment went through, but the place was no longer free. We'll contact you and refund it — nothing else to do.",
};

const ORDER_ERRORS = {
  'not-found': "We couldn't find that place.",
  'not-offered': 'The time to accept this place has passed.',
  'not-one-time': "This place isn't paid for this way. Please reload the page.",
  paypal: "PayPal couldn't be reached. Please try again in a moment.",
  unknown: "PayPal doesn't know that payment. Please try again.",
  mismatch: "That payment doesn't match this place, so we didn't apply it. Please email info@tnsaints.com.",
  declined: "PayPal didn't complete the payment. Nothing was charged; please try again.",
  'no-seat': "Your payment went through, but the place was no longer free. We'll contact you and refund it — nothing else to do.",
};

async function jsonBody(request) {
  try {
    return { body: await readJson(request) };
  } catch (err) {
    if (err instanceof BodyTooLarge) return { error: json({ ok: false, error: 'Too large.' }, { status: 413 }) };
    throw err;
  }
}

/**
 * @returns {Promise<Response|null>} null if not a pay route
 */
export async function payRoutes({ env, ctx, request, rc, session, pathname, method }) {
  // Stripe's billing page for this family: card or bank, receipts, cancelling.
  if (pathname === '/billing/manage' && method === 'GET') {
    if (!stripeConfigured(env)) return message(rc, 'Billing is not available yet', 'Please try again later, or email info@tnsaints.com.', 503);
    const url = await portalUrl(env, session.accountId, `${portalOrigin(env)}${rc.url('/')}`);
    if (!url) return message(rc, 'No payments set up yet', 'Once you have paid for a place, you can manage it here.', 404);
    return seeOtherExternal(url);
  }

  const m = /^\/pay\/([A-Za-z0-9_-]{1,64})(\/approved|\/order|\/captured|\/accept|\/checkout|\/done|\/move)?$/.exec(pathname);
  if (!m) return null;
  if (!REF.test(m[1])) return notFoundResponse(rc);
  const ref = m[1];
  const config = paypalConfig(env);

  // --- Stripe ---------------------------------------------------------------
  if (m[2] === '/done' && method === 'GET') {
    const sessionId = new URL(request.url).searchParams.get('session_id') || '';
    const result = await syncCheckout(env, sessionId, { accountId: session.accountId });
    if (result.ok && result.status === 'complete') {
      ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.pay_stripe', subjectType: 'enrollment', subjectId: ref }));
      return redirect(rc.url('/?notice=paid'));
    }
    if (result.reason === 'no-seat') return message(rc, 'We could not place your child', APPROVE_ERRORS['no-seat'], 409);
    if (result.ok) {
      return message(rc, "We're confirming your payment",
        "Stripe hasn't told us the payment is complete yet. Your family page will show it within a few minutes — there is no need to pay again.", 202);
    }
    return notFoundResponse(rc);
  }
  if ((m[2] === '/checkout' || m[2] === '/move') && method === 'POST') {
    if ((await paymentsProvider(env)) !== 'stripe' || !stripeConfigured(env)) return message(rc, ...STRIPE_ERRORS['not-payable']);
    // A new place is paused with enrollment; moving an existing place never is.
    if (m[2] === '/checkout' && !enrollmentEnabled(env)) {
      return message(rc, 'Payments are paused', "We've paused new enrollments for a moment. Your offer is still yours until its pay-by date. Please try again later, or email info@tnsaints.com.", 503);
    }
    const result = await startCheckout(env, session.accountId, ref, {
      purpose: m[2] === '/move' ? 'move' : 'place', origin: portalOrigin(env), base: rc.url('').replace(/\/$/, ''),
    });
    if (!result.ok) return message(rc, ...(STRIPE_ERRORS[result.reason] || STRIPE_ERRORS['not-payable']));
    ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: m[2] === '/move' ? 'portal.move_started' : 'portal.checkout_started',
      subjectType: 'enrollment', subjectId: ref }));
    return seeOtherExternal(result.url);
  }
  if (m[2] === '/move' && method === 'GET') {
    if ((await paymentsProvider(env)) !== 'stripe' || !stripeConfigured(env)) return message(rc, ...STRIPE_ERRORS['not-payable']);
    const place = await placeForAccount(env, session.accountId, ref);
    if (!place) return notFoundResponse(rc);
    if (await liveSubscriptionFor(env, place.id)) return message(rc, ...STRIPE_ERRORS.already);
    if (!['active', 'past_due'].includes(place.status) || place.billed_outside !== 'paypal_join' || !place.outside_paid_through) {
      return message(rc, ...STRIPE_ERRORS['not-movable']);
    }
    const percentOff = await percentOffFor(env, place);
    const plan = firstCharge({ nowMs: Date.now(), purpose: 'move', paidThrough: place.outside_paid_through, priceCents: place.price_cents, percentOff });
    return stripePayPage(rc, place, chargeSummary(place, plan, percentOff, { purpose: 'move' }), rc.url(`/pay/${ref}/move`),
      'Move your monthly payment',
      `We're moving the academy's monthly payments from PayPal to card or bank account. No setup fee — you've paid it. Once this is done, we cancel your PayPal subscription for you.`,
      { cost: false });
  }

  if (!m[2] && method === 'GET') {
    const offer = await loadOffer(env, session.accountId, ref, config.planColumn);
    if (!offer) return notFoundResponse(rc);
    if (offer.status === 'active') {
      return message(rc, "You're all set", `${offer.child_name}'s place in ${offer.group_name} is confirmed.`);
    }
    if (offer.status !== 'offered' || !offer.offer_expires_at || Date.parse(offer.offer_expires_at) <= Date.now()) {
      return offer.enrollment_mode === 'self_serve'
        ? message(rc, 'This hold has ended', 'The time to pay for this place has passed, so the seat was released. You can sign up again from Programs if there is still room.', 410)
        : message(rc, 'This offer has ended', 'The time to accept this place has passed. Your child is still on the waiting list, and we will be in touch when another place opens.', 410);
    }
    // Paused: no new PayPal payment starts here. The confirmations below are
    // not paused, so a family already mid-payment is still placed.
    if (!enrollmentEnabled(env)) {
      return message(rc, 'Payments are paused', "We've paused new enrollments for a moment. Your offer is still yours until its pay-by date. Please try again later, or email info@tnsaints.com.", 503);
    }
    if (offer.billing !== 'free' && (await paymentsProvider(env)) === 'stripe') {
      if (!stripeConfigured(env) || !offer.price_cents) return message(rc, ...STRIPE_ERRORS['not-payable']);
      const place = await placeForAccount(env, session.accountId, ref);
      if (await liveSubscriptionFor(env, place.id)) return message(rc, ...STRIPE_ERRORS.already);
      const percentOff = offer.billing === 'subscription' ? await percentOffFor(env, place) : 0;
      const summary = offer.billing === 'subscription'
        ? chargeSummary(place, firstCharge({ nowMs: Date.now(), purpose: 'place', startsOn: place.starts_on, priceCents: place.price_cents, percentOff }), percentOff)
        : [`One payment of $${(place.price_cents / 100).toFixed(place.price_cents % 100 ? 2 : 0)}.`];
      return stripePayPage(rc, offer, summary, rc.url(`/pay/${ref}/checkout`));
    }
    if (offer.billing === 'free') {
      return page(rc, 'Accept the place', `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Accept the place</h1>
<p class="lede">${esc(heldLine(offer))}</p>
${placeTable(offer)}
<form method="post" action="${esc(rc.url(`/pay/${offer.ref}/accept`))}"><button class="btn" type="submit">Accept the place</button></form>`);
    }
    if (offer.billing === 'one_time') {
      if (!paypalConfigured(env) || !offer.price_cents) {
        return message(rc, 'Payments are not set up yet', 'Please try again later, or email info@tnsaints.com and we will help.', 503);
      }
      return orderPage(rc, offer, config);
    }
    if (!paypalConfigured(env) || !offer.plan_id) {
      return message(rc, 'Payments are not set up yet', 'Please try again later, or email info@tnsaints.com and we will help.', 503);
    }
    return subscriptionPage(rc, offer, config);
  }

  if (m[2] === '/approved' && method === 'POST') {
    const { body, error } = await jsonBody(request);
    if (error) return error;
    if (!body) return json({ ok: false, error: 'Expected JSON.' }, { status: 415 });
    const subscriptionId = String(body.subscription_id || '');
    if (!SUBSCRIPTION_ID.test(subscriptionId)) return json({ ok: false, error: APPROVE_ERRORS.unknown }, { status: 400 });
    const result = await approveFromPortal(env, session.accountId, ref, subscriptionId);
    if (!result.ok) {
      const status = result.reason === 'not-found' ? 404 : result.reason === 'unknown' ? 409 : 400;
      return json({ ok: false, error: APPROVE_ERRORS[result.reason] || APPROVE_ERRORS.mismatch }, { status });
    }
    ctx.waitUntil(audit(env, {
      actor: `account:${session.accountId}`, action: 'portal.pay_approved', subjectType: 'enrollment', subjectId: ref,
    }));
    return json({ ok: true, redirect: rc.url('/?notice=paid') });
  }

  if (m[2] === '/order' && method === 'POST') {
    const { body, error } = await jsonBody(request);
    if (error) return error;
    if (!body) return json({ ok: false, error: 'Expected JSON.' }, { status: 415 });
    // Starting a payment is paused with enrollment; finishing one never is.
    if (!enrollmentEnabled(env)) return json({ ok: false, error: 'Payments are paused for a moment. Please try again later.' }, { status: 503 });
    if (!paypalConfigured(env)) return json({ ok: false, error: ORDER_ERRORS.paypal }, { status: 503 });
    const result = await createOrderForPortal(env, session.accountId, ref);
    if (!result.ok) {
      const status = result.reason === 'not-found' ? 404 : result.reason === 'paypal' ? 502 : 409;
      return json({ ok: false, error: ORDER_ERRORS[result.reason] }, { status });
    }
    return json({ ok: true, order_id: result.orderId });
  }

  // A free place: accepting confirms it, while the offer still holds the seat
  // (activateEnrollment re-checks; a lapsed offer whose seat went elsewhere is not placed).
  if (m[2] === '/accept' && method === 'POST') {
    const offer = await loadOffer(env, session.accountId, ref, config.planColumn);
    if (!offer || offer.billing !== 'free') return notFoundResponse(rc);
    if (offer.status === 'active') return redirect(rc.url('/?notice=registered'));
    if (offer.status !== 'offered' || !(await activateEnrollment(env, offer.id))) {
      return message(rc, 'This offer has ended', 'The time to accept this place has passed. We will be in touch if another place opens.', 410);
    }
    ctx.waitUntil(audit(env, {
      actor: `account:${session.accountId}`, action: 'portal.place_accepted', subjectType: 'enrollment', subjectId: ref,
    }));
    return redirect(rc.url('/?notice=registered'));
  }

  if (m[2] === '/captured' && method === 'POST') {
    const { body, error } = await jsonBody(request);
    if (error) return error;
    if (!body) return json({ ok: false, error: 'Expected JSON.' }, { status: 415 });
    const orderId = String(body.order_id || '');
    if (!ORDER_ID.test(orderId)) return json({ ok: false, error: ORDER_ERRORS.unknown }, { status: 400 });
    const result = await captureForPortal(env, session.accountId, ref, orderId);
    if (!result.ok) {
      const status = result.reason === 'not-found' ? 404 : result.reason === 'paypal' ? 502 : result.reason === 'no-seat' ? 409 : 400;
      return json({ ok: false, error: ORDER_ERRORS[result.reason] || ORDER_ERRORS.mismatch }, { status });
    }
    ctx.waitUntil(audit(env, {
      actor: `account:${session.accountId}`, action: 'portal.pay_captured', subjectType: 'enrollment', subjectId: ref,
    }));
    return json({ ok: true, redirect: rc.url('/?notice=paid') });
  }

  return null;
}
