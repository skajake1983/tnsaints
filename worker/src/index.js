/**
 * Tennessee Saints — evaluation registration API.
 *
 * Routes
 *   GET  /api/health
 *   GET  /api/availability          remaining spots per session
 *   POST /api/register              claim a spot (or land on the waitlist)
 *   GET  /api/admin/registrations   roster export, Bearer token required
 *
 * Everything that decides who gets a spot — the capacity check, the
 * registration deadline, Turnstile verification, and field validation —
 * runs here. The browser is treated as untrusted input throughout.
 */

import { corsHeaders, json, errorResponse, hashIp, clientIp, toCsv } from './http.js';
import { sendRegistrationEmails, sendRosterDigest, sendCancellationAlert } from './email.js';
import { verifyTurnstile } from './turnstile.js';
import { validateRegistration, botSignals } from './validate.js';
import { handleAdmin } from './admin/router.js';
import { audit } from './auth/staff.js';
import {
  getAvailability,
  registrationWindow,
  claimSpot,
  isRateLimited,
  lookupByCancelToken,
  cancelByToken,
} from './registration.js';

/** Generous ceiling for a registration payload, which runs about 2 KB. */
const MAX_BODY_BYTES = 16 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Hostname dispatch happens before anything else, including CORS. The two
    // surfaces have opposite defaults — the public API is open to allow-listed
    // origins, the admin host is closed to everyone who is not staff — and
    // mixing their routing is how a public path ends up on the private host or
    // an admin path ends up unauthenticated. See admin/router.js.
    const admin = adminRequest(url, env);
    if (admin.admin) {
      try {
        return await handleAdmin(request, env, ctx, admin.path);
      } catch (err) {
        console.error('Unhandled admin error:', err?.stack || err?.message || err);
        return new Response('Something went wrong. Try again, or text Jacob.', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }

    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true }, { cors });
      }

      if (url.pathname === '/api/availability' && request.method === 'GET') {
        return await handleAvailability(env, cors);
      }

      if (url.pathname === '/api/register' && request.method === 'POST') {
        return await handleRegister(request, env, ctx, cors);
      }

      // GET is read-only by design — see lookupByCancelToken().
      if (url.pathname === '/api/cancel/lookup' && request.method === 'GET') {
        return await handleCancelLookup(url, env, cors);
      }

      if (url.pathname === '/api/cancel' && request.method === 'POST') {
        return await handleCancel(request, env, ctx, cors);
      }

      if (url.pathname === '/api/admin/registrations' && request.method === 'GET') {
        return await handleAdminExport(request, env, ctx, cors);
      }

      // Once [assets] is enabled in wrangler.toml, static files are served
      // automatically before the request ever reaches this handler.
      return errorResponse('Not found', 404, cors);
    } catch (err) {
      // Log the detail, return none of it.
      console.error('Unhandled worker error:', err?.stack || err?.message || err);
      return errorResponse('Something went wrong on our end. Please try again.', 500, cors);
    }
  },

  /**
   * Cron handler — emails the final roster as a CSV attachment.
   *
   * The token-protected export endpoint still exists for on-demand pulls, but
   * the roster that matters is the one on event weekend, and that should not
   * depend on anyone remembering to run a command with a token on the right
   * evening. This pushes it instead.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendRosterDigest(env, { reason: event.cron || 'scheduled' }));
  },
};

/** Local-development-only prefix — see adminRequest(). */
const DEV_ADMIN_PREFIX = '/__admin';

/**
 * Decide whether a request belongs to the staff surface, and what path it is
 * asking for.
 *
 * In production this is purely a hostname test. ADMIN_HOSTNAME unset means the
 * admin surface does not exist at all, which is the safe direction for a
 * misconfiguration.
 *
 * Local development needs a second door, because `wrangler dev` does not
 * simulate multiple hostnames: whatever Host header you send, the Worker sees
 * the first entry in `routes` — verified, not assumed, and `--host` does not
 * change it in local mode. Without a second door the admin surface could only
 * ever be exercised for the first time in production, on a deadline, against
 * real children's data.
 *
 * That door is a path prefix that only opens when DEV_ADMIN_EMAIL is set.
 * DEV_ADMIN_EMAIL lives only in .dev.vars, which is gitignored and is not
 * uploaded by `wrangler deploy` — so in production this branch is unreachable
 * and /__admin is just another 404 from the public router.
 */
function adminRequest(url, env) {
  const configured = String(env.ADMIN_HOSTNAME || '').trim().toLowerCase();

  if (configured && url.hostname.toLowerCase() === configured) {
    return { admin: true, path: url.pathname };
  }

  if (env.DEV_ADMIN_EMAIL && url.pathname.startsWith(DEV_ADMIN_PREFIX)) {
    return { admin: true, path: url.pathname.slice(DEV_ADMIN_PREFIX.length) || '/' };
  }

  return { admin: false, path: url.pathname };
}

/**
 * Public session status.
 *
 * Deliberately returns open/full only, never taken/remaining/capacity. This
 * endpoint is unauthenticated, so publishing exact counts would tell anyone
 * how the campaign is performing — and early on, "0 of 50 taken" is exactly
 * what you do not want visible. Exact numbers stay on the admin endpoint.
 */
function publicSessions(availability) {
  return availability.sessions.map((s) => ({
    session_time: s.session_time,
    full: s.full,
  }));
}

async function handleAvailability(env, cors) {
  const availability = await getAvailability(env);
  const window = registrationWindow(env);

  return json(
    {
      ok: true,
      registration_open: window.open,
      closes_at: window.closesAt ? window.closesAt.toISOString() : null,
      event_id: availability.event_id,
      event_label: availability.event_label,
      sessions: publicSessions(availability),
      all_full: availability.all_full,
    },
    { cors }
  );
}

async function handleRegister(request, env, ctx, cors) {
  // Reject cross-origin posts outright. corsHeaders() only sets the
  // allow-origin header for allow-listed origins, so its absence means the
  // caller is not one of our pages.
  if (!cors['Access-Control-Allow-Origin']) {
    return errorResponse('Requests from this origin are not allowed.', 403, cors);
  }

  const window = registrationWindow(env);
  if (!window.open) {
    return errorResponse(
      'Registration for this evaluation has closed. Please email info@tnsaints.com and we will add you to the list for our next date.',
      403,
      cors,
      { registration_open: false }
    );
  }

  // A real registration is ~2 KB. Refuse anything wildly larger before
  // parsing it, so a junk payload cannot make the Worker buffer megabytes of
  // JSON just to reject it.
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse('That submission was too large.', 413, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('We could not read that submission. Please try again.', 400, cors);
  }

  // Cheap checks before spending a subrequest on Turnstile.
  const signals = botSignals(body);
  if (signals.length) {
    console.warn('Rejected submission on bot signals:', signals.join(','));
    // Deliberately vague: naming the honeypot teaches an attacker to avoid it.
    return errorResponse('We could not verify that submission. Please try again.', 400, cors);
  }

  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);

  const turnstile = await verifyTurnstile(body.turnstile_token, ip, env);
  if (!turnstile.ok) {
    const status = turnstile.reason === 'misconfigured' ? 500 : 403;
    return errorResponse(
      'We could not verify that you are human. Please refresh the page and try again.',
      status,
      cors
    );
  }

  if (await isRateLimited(env, ipHash)) {
    return errorResponse(
      'Too many registrations from this connection. If you are signing up multiple players, please email info@tnsaints.com.',
      429,
      cors
    );
  }

  const validation = validateRegistration(body, env);
  if (!validation.ok) {
    return errorResponse('Please correct the highlighted fields.', 400, cors, {
      errors: validation.errors,
    });
  }

  const result = await claimSpot(env, validation.value, ipHash);

  if (result.status === 'duplicate') {
    return errorResponse(
      'That player is already registered for this evaluation. Email info@tnsaints.com if you need to change the session time.',
      409,
      cors
    );
  }

  // The spot is already durable in D1 at this point. Notifications go out
  // after the response so a slow or failing email provider can never delay,
  // or worse undo, a registration that already succeeded.
  ctx.waitUntil(sendRegistrationEmails(env, validation.value, result));

  const availability = await getAvailability(env);

  if (result.status === 'waitlist') {
    return json(
      {
        ok: true,
        status: 'waitlist',
        position: result.position,
        message:
          'That session is full, so we have added your player to the waiting list. We will email you if a spot opens or when we schedule another evaluation date.',
        sessions: publicSessions(availability),
      },
      { cors }
    );
  }

  return json(
    {
      ok: true,
      status: 'confirmed',
      message:
        'Your player is registered. Watch for a confirmation email with details for August 29.',
      sessions: publicSessions(availability),
    },
    { cors }
  );
}

async function handleCancelLookup(url, env, cors) {
  const registration = await lookupByCancelToken(env, url.searchParams.get('t'));

  if (!registration) {
    return errorResponse('That cancellation link is not valid.', 404, cors);
  }

  return json(
    {
      ok: true,
      player_name: registration.player_name,
      session_time: registration.session_time,
      grade: registration.grade,
      status: registration.status,
      already_cancelled: registration.status === 'cancelled',
    },
    { cors }
  );
}

async function handleCancel(request, env, ctx, cors) {
  if (!cors['Access-Control-Allow-Origin']) {
    return errorResponse('Requests from this origin are not allowed.', 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('We could not read that request. Please try again.', 400, cors);
  }

  const result = await cancelByToken(env, body.token, body.reason);

  if (!result.ok) {
    if (result.code === 'already-cancelled') {
      return json(
        { ok: true, already_cancelled: true, message: 'That spot was already cancelled.' },
        { cors }
      );
    }
    return errorResponse('That cancellation link is not valid.', 404, cors);
  }

  // Told after the row is already updated, so a mail failure cannot leave the
  // spot occupied.
  ctx.waitUntil(sendCancellationAlert(env, result));

  return json(
    {
      ok: true,
      message:
        'Your spot has been released and is now open for another family. Thank you for letting us know.',
    },
    { cors }
  );
}

/**
 * Roster export. Without this the registrations would be trapped in D1 —
 * owning the data only matters if you can get it out.
 */
async function handleAdminExport(request, env, ctx, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!env.ADMIN_TOKEN || !(await verifyAdminToken(token, env.ADMIN_TOKEN))) {
    return errorResponse('Unauthorized', 401, cors);
  }

  const url = new URL(request.url);
  const include = url.searchParams.get('include') || '';

  // A cancel token is a capability, not data: holding one cancels that
  // family's place with no other credential. Once this export is shared with
  // coaches, including it by default hands out one capability per family.
  // Opt in explicitly when a token is genuinely needed.
  const includeTokens = include === 'cancel_token';
  const tokenColumn = includeTokens ? 'cancel_token,' : '';

  // Medical-note TEXT is withheld from this path by default, matching the
  // capability model: token:automation is granted roster:view/contact/export
  // but NOT roster:medical, precisely because the note text belongs behind the
  // audited, admin-only endpoint. The shared bearer token is human-less and may
  // be dropped into a runbook, so it must not silently carry every child's
  // medical history. A boolean flag ships instead; the full text is an explicit
  // opt-in for the rare case it is genuinely needed, and either way the export
  // is audited so a bulk read of sensitive data leaves a trace like every other.
  const includeMedical = include === 'medical_notes';
  const medicalColumn = includeMedical
    ? 'medical_notes,'
    : `CASE WHEN medical_notes IS NOT NULL AND TRIM(medical_notes) != ''
            THEN 1 ELSE 0 END AS has_medical_notes,`;

  const { results } = await env.DB.prepare(
    `SELECT id, session_time, status, player_name, grade, years_experience,
            parent_name, parent_email, phone, school,
            emergency_contact_name, emergency_contact_phone, ${medicalColumn}
            assumption_of_risk, medical_release, photo_release,
            signature, signed_at,
            highlight_link, player_notes, created_at,
            ${tokenColumn} cancelled_at, cancel_reason
       FROM registrations
      WHERE event_id = ?1
      ORDER BY session_time, status DESC, id`
  )
    .bind(env.EVENT_ID)
    .all();

  // The most sensitive bulk read in the system, previously the one action with
  // no record. Identifiers and flags only — never the exported data itself.
  ctx.waitUntil(
    audit(env, {
      actor: 'token:automation',
      action: 'roster.export',
      subjectType: 'event',
      subjectId: env.EVENT_ID,
      detail: {
        count: (results || []).length,
        format: url.searchParams.get('format') === 'csv' ? 'csv' : 'json',
        included_medical: includeMedical,
        included_cancel_token: includeTokens,
      },
    })
  );

  if (url.searchParams.get('format') === 'csv') {
    return new Response(toCsv(results || []), {
      headers: {
        ...cors,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tnsaints-${env.EVENT_ID}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return json({ ok: true, count: (results || []).length, registrations: results || [] }, { cors });
}

/**
 * Constant-time admin token comparison.
 *
 * Both values are hashed to a fixed 32 bytes first. Comparing the raw strings
 * would have to bail out early when the lengths differ, and that early return
 * is itself measurable — it leaks the length of the real token. Hashing makes
 * every comparison the same size, so timing reveals nothing.
 */
async function verifyAdminToken(provided, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

