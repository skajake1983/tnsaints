/**
 * Cloudflare Access JWT verification.
 *
 * Access sits in front of admin.tnsaints.com and will not pass a request
 * through without authenticating the human first. That is the door. This
 * module is the second lock: it proves the assertion attached to the request
 * really came from our Access team and really is for this application.
 *
 * Verifying rather than trusting the header matters because the Worker is
 * reachable at other hostnames. A request arriving at api.tnsaints.com with a
 * hand-written Cf-Access-Jwt-Assertion header never passed through Access at
 * all, and nothing but signature verification distinguishes it from one that
 * did.
 *
 * WHY jose RATHER THAN HAND-ROLLED
 * ---------------------------------
 * The rest of this Worker has no runtime dependencies, deliberately. This is
 * the exception, and the reasoning is specific rather than a change of taste:
 * the failure mode of a subtly wrong RS256 + JWKS verifier is not a visible
 * break. It is silently accepting a forged token against children's medical
 * notes, and it looks exactly like working code until someone tries it. The
 * subtleties — algorithm confusion, key rotation, the full set of claim checks
 * — are each a known CVE class in other people's code.
 *
 * Contrast Stripe webhook verification later on, which is one HMAC-SHA256 over
 * a known string and stays hand-rolled. Take the dependency where the crypto is
 * subtle and the failure is silent.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Module scope on purpose: jose caches fetched keys on the set object, so one
 * instance per isolate means the JWKS endpoint is hit on cold start and key
 * rotation rather than on every request. A per-request instance would make
 * every dashboard click a subrequest to Cloudflare, and burn the subrequest
 * budget for no benefit.
 *
 * Keyed by team domain so a config change cannot serve a stale key set.
 */
const jwksCache = new Map();

function jwksFor(teamDomain) {
  const existing = jwksCache.get(teamDomain);
  if (existing) return existing;

  const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  const set = createRemoteJWKSet(url, {
    // Rotation is rare; a failed lookup should not stall a dashboard request
    // for long. Both are jose defaults made explicit so they are reviewable.
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });

  jwksCache.set(teamDomain, set);
  return set;
}

/**
 * Normalised for comparison against staff.email_norm. Identity providers are
 * inconsistent about casing, and an admin who typed a capital letter when
 * adding a coach should not lock that coach out.
 */
export function normEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Pull the assertion off the request.
 *
 * The header is what Access sets for every proxied request. The cookie is the
 * fallback that keeps direct navigation working, since a browser following a
 * redirect back from the login flow carries CF_Authorization but the header is
 * added by the edge, not the browser.
 */
export function readAccessToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;

  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Local-development sign-in, and the reason it cannot become a production hole.
 *
 * There is no Cloudflare Access in front of `wrangler dev`, so without this the
 * admin surface would be untestable locally and would only ever be exercised
 * for the first time in production — on a deadline, against real children's
 * data. That is a worse risk than this function, but only if the function is
 * genuinely unreachable in production, so:
 *
 *   1. DEV_ADMIN_EMAIL must be set. It exists only in .dev.vars, which is
 *      gitignored and is NOT uploaded by `wrangler deploy` — secrets reach
 *      production solely through an explicit `wrangler secret put`. This same
 *      variable also gates the /__admin dev route in index.js, so without it
 *      there is no local door to walk through either.
 *
 *   2. ACCESS_AUD must be EMPTY. Production sets it in wrangler.toml, which is
 *      committed and deployed. So even if someone deliberately pushed
 *      DEV_ADMIN_EMAIL as a production secret, this stays dead — and the day
 *      ACCESS_AUD is filled in (Phase A setup), condition 2 fails permanently
 *      and independently of condition 1.
 *
 * Two independent conditions, each sufficient on its own to close the door.
 *
 * An earlier version keyed on the request hostname being localhost. That was
 * stronger in principle and useless in practice: `wrangler dev` reports the
 * hostname of the first configured route, not the address you connected to, so
 * the check was false locally and the bypass never worked. Recording it here
 * because the replacement is weaker and the reason should not be re-litigated
 * from scratch.
 *
 * Every use logs a warning, so it cannot sit forgotten and silent.
 */
export function devPrincipalEmail(request, env) {
  const email = normEmail(env.DEV_ADMIN_EMAIL);
  if (!email) return null;

  if (String(env.ACCESS_AUD || '').trim()) {
    console.error(
      JSON.stringify({
        event: 'dev_auth_bypass_refused',
        reason: 'ACCESS_AUD is configured — this is a real deployment',
      })
    );
    return null;
  }

  console.warn(
    JSON.stringify({ event: 'dev_auth_bypass_used', email, note: 'local development only' })
  );
  return email;
}

/**
 * Verify an Access assertion.
 *
 * Every check here is load-bearing:
 *
 *   algorithms — PINNED to RS256. This is the one that bites. Without it a
 *     token whose header says {"alg":"none"} can be accepted as valid, and a
 *     token saying HS256 invites the classic confusion attack where the
 *     library verifies an HMAC using the public RSA key as the shared secret —
 *     a key the attacker also has, because it is public.
 *
 *   audience   — the AUD tag of THIS Access application. Without it, a token
 *     minted for any other application in the same Cloudflare account is
 *     accepted here. Same team domain, same signing keys, entirely different
 *     authorization decision.
 *
 *   issuer     — the team domain, so a token from someone else's Access tenant
 *     cannot be replayed against ours.
 *
 *   exp/iat/nbf — jose enforces these itself given a clock. clockTolerance
 *     absorbs small skew without accepting a genuinely expired session.
 *
 * @returns {Promise<{ok: true, email: string, sub: string, claims: object}
 *                 | {ok: false, reason: string}>}
 */
export async function verifyAccessJwt(request, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;

  // A missing configuration must fail closed. The tempting alternative —
  // "no Access config, so skip the check" — turns a deployment mistake into an
  // unauthenticated admin panel, which is the worst possible default.
  if (!teamDomain || !aud) {
    console.error(
      JSON.stringify({
        event: 'access_misconfigured',
        has_team_domain: Boolean(teamDomain),
        has_aud: Boolean(aud),
      })
    );
    return { ok: false, reason: 'misconfigured' };
  }

  const token = readAccessToken(request);
  if (!token) return { ok: false, reason: 'no-token' };

  try {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      algorithms: ['RS256'],
      audience: aud,
      issuer: `https://${teamDomain}`,
      clockTolerance: 30,
    });

    const email = normEmail(payload.email);
    if (!email) return { ok: false, reason: 'no-email-claim' };

    return { ok: true, email, sub: String(payload.sub || ''), claims: payload };
  } catch (err) {
    // Log the class of failure, never the token. A rejected assertion is still
    // a credential and does not belong in logs.
    console.warn(
      JSON.stringify({ event: 'access_jwt_rejected', code: err?.code || err?.name || 'unknown' })
    );
    return { ok: false, reason: 'invalid' };
  }
}
