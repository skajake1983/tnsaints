/**
 * Accepting an offered place: the pay page and its confirmation.
 *
 * GET  /pay/:ref            the offer, and PayPal's subscription button
 * POST /pay/:ref/approved   { subscription_id } from the button, checked with PayPal
 *
 * The page exists only while this family's offer is live, so paying for a
 * place that has no seat and no schedule is not possible from here (the
 * owner's rule). PayPal is sent the enrollment's unguessable ref as
 * custom_id — never a child's name.
 *
 * The button is PayPal's JavaScript SDK. This page alone loads it: its CSP
 * allows PayPal's hosts plus a per-response nonce for the one inline script,
 * and COOP is relaxed to same-origin-allow-popups so PayPal's window can talk
 * back. The inline script is static; everything it needs comes from data-
 * attributes, never interpolated into code.
 */

import { esc, portalPage, portalResponse, notFoundResponse } from './ui.js';
import { randomToken } from '../lib/crypto.js';
import { readJson, BodyTooLarge } from '../lib/body.js';
import { json } from '../http.js';
import { audit } from '../auth/staff.js';
import { paypalConfig, paypalConfigured } from '../payments/paypal.js';
import { approveFromPortal } from '../payments/billing.js';
import { priceLine, enrollmentEnabled } from '../programs/enrollment.js';

const NAV = [{ href: '/', label: 'Family' }, { href: '/account', label: 'Account' }];
const REF = /^[A-Za-z0-9_-]{16,43}$/;
const SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,40}$/;

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

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;

async function loadOffer(env, accountId, ref, planColumn) {
  return env.DB.prepare(
    `SELECT e.id, e.ref, e.status, e.offer_expires_at, p.display_name AS child_name,
            pr.id AS program_id, pr.name AS program_name, pr.billing, pr.price_cents, pr.setup_fee_cents,
            pr.${planColumn} AS plan_id,
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

/** The subscription's first billing date: the group's first session, if it is still ahead. */
function startTime(startsOn, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || ''))) return '';
  const at = Date.parse(`${startsOn}T14:00:00Z`); // 8 or 9 AM Central
  return at > now + 24 * 60 * 60 * 1000 ? new Date(at).toISOString().replace('.000', '') : '';
}

async function payPage(env, rc, offer, config) {
  const nonce = randomToken(16);
  const start = startTime(offer.starts_on);
  const body = `<p><a href="${esc(rc.url('/'))}">&larr; Back to your family</a></p>
<h1>Accept the place</h1>
<p class="lede">A place is being held for ${esc(offer.child_name)} until ${esc(longDate(offer.offer_expires_at))}.</p>
<section class="panel" aria-label="The place">
  <table style="border-collapse:collapse">
    <tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">Program</th><td>${esc(offer.program_name)}</td></tr>
    <tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">Group</th><td>${esc(offer.group_name)}</td></tr>
    <tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">When</th><td>${esc(offer.schedule_summary)}</td></tr>
    ${offer.location ? `<tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">Where</th><td>${esc(offer.location)}</td></tr>` : ''}
    ${offer.starts_on ? `<tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">First session</th><td>${esc(longDate(`${offer.starts_on}T17:00:00Z`))}</td></tr>` : ''}
    <tr><th scope="row" style="text-align:left;padding:4px 16px 4px 0">Cost</th><td>${esc(priceLine(offer))}</td></tr>
  </table>
</section>
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

const APPROVE_ERRORS = {
  'not-found': "We couldn't find that place.",
  unknown: "PayPal doesn't know that subscription yet. If you just paid, wait a minute and refresh your family page.",
  mismatch: "That PayPal subscription doesn't match this place, so we didn't apply it. Please email info@tnsaints.com.",
  taken: 'That PayPal subscription is already in use for another place. Please email info@tnsaints.com.',
  'no-seat': "Your payment went through, but the place was no longer free. We'll contact you and refund it — nothing else to do.",
};

/**
 * @returns {Promise<Response|null>} null if not a pay route
 */
export async function payRoutes({ env, ctx, request, rc, session, pathname, method }) {
  const m = /^\/pay\/([A-Za-z0-9_-]{1,64})(\/approved)?$/.exec(pathname);
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
      return message(rc, 'This offer has ended', 'The time to accept this place has passed. Your child is still on the waiting list, and we will be in touch when another place opens.', 410);
    }
    // Paused: no new PayPal subscription starts here. The confirmation below is
    // not paused, so a family already mid-payment is still placed.
    if (!enrollmentEnabled(env)) {
      return message(rc, 'Payments are paused', "We've paused new enrollments for a moment. Your offer is still yours until its pay-by date. Please try again later, or email info@tnsaints.com.", 503);
    }
    if (!paypalConfigured(env) || !offer.plan_id) {
      return message(rc, 'Payments are not set up yet', 'Please try again later, or email info@tnsaints.com and we will help.', 503);
    }
    return payPage(env, rc, offer, config);
  }

  if (m[2] && method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json({ ok: false, error: 'Too large.' }, { status: 413 });
      throw err;
    }
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

  return null;
}
