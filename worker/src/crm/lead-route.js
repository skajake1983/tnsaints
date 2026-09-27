/**
 * POST /api/lead — the website's contact and interest forms.
 *
 * Same front door as /api/register: allow-listed origins only, a honeypot and
 * a too-fast check, Turnstile, a salted IP hash (never the IP). Plus limits of
 * five per connection per ten minutes and two hundred a day in total, so a
 * script cannot fill the CRM.
 *
 * LEADS_ENABLED must be exactly "true". Anything else answers 503, and the
 * website falls back to its old Formspree form: switching this off loses no
 * inquiries.
 */

import { errorResponse, json, hashIp, clientIp } from '../http.js';
import { botSignals } from '../validate.js';
import { verifyTurnstile } from '../turnstile.js';
import { flag } from '../lib/flags.js';
import { rateLimit } from '../lib/ratelimit.js';
import { readJson, BodyTooLarge } from '../lib/body.js';
import { validateLead, recordLead } from './intake.js';

const THANKS = "Thanks — we've got your message and will be in touch soon.";

export async function handleLead(request, env, cors) {
  if (!cors['Access-Control-Allow-Origin']) {
    return errorResponse('Requests from this origin are not allowed.', 403, cors);
  }
  if (!flag(env, 'LEADS_ENABLED', false)) {
    return errorResponse('Please try again in a moment.', 503, cors, { fallback: true });
  }

  let body;
  try {
    body = await readJson(request, 16 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLarge) return errorResponse('That message was too long to send.', 413, cors);
    throw err;
  }
  if (!body) return errorResponse('We could not read that form. Please try again.', 400, cors);

  // A bot that filled the honeypot or submitted inhumanly fast gets the same
  // thanks as everyone else, and nothing is stored. Telling it which check
  // caught it only teaches it to avoid that check.
  if (botSignals(body).length) return json({ ok: true, message: THANKS }, { cors });

  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);
  const limits = await rateLimit(env, [
    { scope: 'lead-ip-10m', subject: ipHash, limit: 5, windowSeconds: 10 * 60 },
    { scope: 'lead-day', subject: 'all', limit: 200, windowSeconds: 24 * 60 * 60 },
  ]);
  if (!limits.allowed) {
    return errorResponse('We have had a lot of messages from this connection. Please try again later, or email info@tnsaints.com.', 429, cors);
  }

  const human = await verifyTurnstile(body.turnstile_token, ip, env);
  if (!human.ok) {
    return errorResponse('We could not verify that you are human. Please refresh the page and try again.',
      human.reason === 'misconfigured' ? 500 : 403, cors);
  }

  const validation = validateLead(body);
  if (!validation.ok) {
    return errorResponse('Please correct the highlighted fields.', 400, cors, { errors: validation.errors });
  }

  await recordLead(env, { value: validation.value, ipHash });
  return json({ ok: true, message: THANKS }, { cors });
}
