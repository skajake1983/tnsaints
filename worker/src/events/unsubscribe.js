/**
 * Unsubscribing from event invitations (the Events plan, phase EV5), on
 * api.tnsaints.com:
 *
 *   GET  /api/unsubscribe?t=            what the link is for: a masked address (read-only,
 *                                       so a mail scanner fetching the link changes nothing)
 *   POST /api/unsubscribe               the website's button (unsubscribe.html), from our origin
 *   POST /api/unsubscribe/one-click?t=  RFC 8058: Gmail's and Outlook's own button. Mail
 *                                       providers send no Origin, so none is required;
 *                                       limited per connection; safe to repeat.
 *
 * Unsubscribing stops every future invitation to that address (by keyed hash,
 * email_suppressions). It does not stop messages a family asked for —
 * evaluation results, sign-up receipts — and does not mark them do-not-contact.
 */

import { json, errorResponse, hashIp, clientIp } from '../http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { readJson, BodyTooLarge } from '../lib/body.js';
import { lookupUnsubscribe, applyUnsubscribe } from './invitations.js';

export async function handleUnsubscribe(request, env, cors, url) {
  if (url.pathname === '/api/unsubscribe' && request.method === 'GET') {
    const found = await lookupUnsubscribe(env, url.searchParams.get('t'));
    if (!found) return errorResponse('That unsubscribe link is not valid.', 404, cors);
    return json({ ok: true, address: found.masked, already: found.done }, { cors });
  }
  if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
    if (!cors['Access-Control-Allow-Origin']) return errorResponse('Requests from this origin are not allowed.', 403, cors);
    let body;
    try {
      body = await readJson(request, 4 * 1024);
    } catch (err) {
      if (err instanceof BodyTooLarge) return errorResponse('That request was too large.', 413, cors);
      throw err;
    }
    const done = await applyUnsubscribe(env, String(body?.t || ''), 'link');
    if (!done.ok) return errorResponse('That unsubscribe link is not valid.', 404, cors);
    return json({ ok: true, already: done.already, message: "Done. You won't get event invitations from us at this address." }, { cors });
  }
  if (url.pathname === '/api/unsubscribe/one-click' && request.method === 'POST') {
    const ipHash = await hashIp(clientIp(request), env.IP_HASH_SALT);
    const limit = await rateLimit(env, [{ scope: 'unsubscribe-ip-10m', subject: ipHash, limit: 30, windowSeconds: 10 * 60 }]);
    if (!limit.allowed) return new Response('Too many requests', { status: 429 });
    const done = await applyUnsubscribe(env, String(url.searchParams.get('t') || ''), 'one-click');
    return new Response(done.ok ? 'Unsubscribed' : 'Not found', {
      status: done.ok ? 200 : 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return null;
}
