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

function placeTable(offer) {
  const row = (label, value) => `<tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `<section class="panel" aria-label="The place">
  <table style="border-collapse:collapse">
    ${row('Program', offer.program_name)}
    ${row('Group', offer.group_name)}
    ${row('When', offer.schedule_summary)}
    ${offer.location ? row('Where', offer.location) : ''}
    ${offer.starts_on ? row('First session', longDate(`${offer.starts_on}T17:00:00Z`)) : ''}
    ${row('Cost', priceLine(offer))}
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
  const m = /^\/pay\/([A-Za-z0-9_-]{1,64})(\/approved|\/order|\/captured|\/accept)?$/.exec(pathname);
  if (!m) return null;
  if (!REF.test(m[1])) return notFoundResponse(rc);
  const ref = m[1];
  const config = paypalConfig(env);

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
