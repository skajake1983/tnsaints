/**
 * Billing reconciliation (billing:manage): subscriptions the system could not
 * place by itself (old Join-page families, pasted ids) and places paid for
 * without a seat.
 */

import { audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { getProgram, listGroups } from '../../programs/enrollment.js';
import {
  listUnlinked, listPaidWithoutSeat, linkableChildren, linkToChild, importSubscription, lookup as lookupSubscription,
} from '../../payments/reconcile.js';
import { syncSubscription } from '../../payments/billing.js';
import { paypalEnv } from '../../payments/paypal.js';
import { page, htmlResponse } from '../ui.js';
import { billingBody, BILLING_STYLES } from '../billing-ui.js';
import { NAV, denyHtml, seeOther } from '../nav.js';
import { ENROLLMENT_PROGRAM } from './enrollments.js';

const SUBSCRIPTION_ID_RE = /^I-[A-Z0-9]{6,40}$/;
const denyBilling = denyHtml('Billing', 'Billing is limited to academy admins.');

export const routes = [
  {
    method: 'GET', path: '/billing', cap: 'billing:manage', deny: denyBilling,
    handler: ({ env, ctx, principal, url, base }) => renderBilling(env, ctx, principal, url, base),
  },
  {
    method: 'POST', path: '/billing/import', cap: 'billing:manage', deny: denyBilling,
    handler: ({ request, env, ctx, principal, base }) => handleBillingPost(request, env, ctx, principal, 'import', NaN, base),
  },
  {
    method: 'POST', path: /^\/billing\/(\d{1,12})\/(sync|link)$/, cap: 'billing:manage', deny: denyBilling,
    handler: ({ request, env, ctx, principal, base }, m) =>
      handleBillingPost(request, env, ctx, principal, m[2], Number(m[1]), base),
  },
];

async function renderBilling(env, ctx, principal, url, base) {
  let message = url.searchParams.get('msg');
  let found = null;
  const lookupId = String(url.searchParams.get('lookup') || '').trim().toUpperCase();
  if (lookupId) {
    if (!SUBSCRIPTION_ID_RE.test(lookupId)) {
      message = 'invalid';
    } else {
      found = await lookupSubscription(env, lookupId);
      if (!found) message = 'not-found';
      // A lookup shows a payer's name and email: worth a trace, carrying only the id.
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'billing.lookup', subjectType: 'subscription', subjectId: lookupId }));
    }
  }
  const program = await getProgram(env, ENROLLMENT_PROGRAM);
  const [unlinked, paidNoSeat, children, groups] = await Promise.all([
    listUnlinked(env), listPaidWithoutSeat(env), linkableChildren(env), program ? listGroups(env, program.id) : [],
  ]);
  return htmlResponse(page({
    title: 'Billing', principal, nav: NAV, current: '/billing',
    body: billingBody({ unlinked, paidNoSeat, children, groups, found, message, env: paypalEnv(env), base }),
    extraStyles: BILLING_STYLES,
  }));
}

async function handleBillingPost(request, env, ctx, principal, action, billingId, base) {
  const back = (msg) => seeOther(base, `/billing?msg=${msg}`);
  let form;
  try {
    form = await readForm(request);
  } catch {
    form = null;
  }
  if (!form) return back('state');
  const log = (act, subjectType, subjectId, detail) =>
    ctx.waitUntil(audit(env, { actor: principal.email, action: act, subjectType, subjectId, detail }));

  if (action === 'import') {
    const id = String(form.get('subscription_id') || '').trim().toUpperCase();
    if (!SUBSCRIPTION_ID_RE.test(id)) return back('invalid');
    const result = await importSubscription(env, id);
    if (!result.ok) return back('not-found');
    log('billing.import', 'subscription', id, { linked: Boolean(result.enrollmentId) });
    return back('imported');
  }

  const row = await env.DB.prepare(`SELECT id, paypal_subscription_id, source FROM billing_subscriptions WHERE id = ?1`)
    .bind(billingId)
    .first();
  if (!row) return back('state');

  if (action === 'sync') {
    await syncSubscription(env, row.paypal_subscription_id, { source: row.source });
    log('billing.sync', 'subscription', row.paypal_subscription_id);
    return back('synced');
  }

  if (action === 'link') {
    const playerId = Number(form.get('player_id'));
    const groupId = Number(form.get('group_id'));
    if (!Number.isInteger(playerId) || !Number.isInteger(groupId)) return back('state');
    const result = await linkToChild(env, { billingId: row.id, playerId, groupId, staffEmail: principal.email });
    if (result === 'linked') log('billing.link', 'subscription', row.paypal_subscription_id, { player: playerId, group: groupId });
    return back(result);
  }
  return back('state');
}
