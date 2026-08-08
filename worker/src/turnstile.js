/**
 * Cloudflare Turnstile server-side verification.
 *
 * The widget token that the browser produces proves nothing on its own — a
 * bot can POST straight to this API and skip the widget entirely. The token
 * only becomes meaningful once Cloudflare confirms it here, server-side,
 * which is what this module does.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(env) {
  return String(env.TURNSTILE_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyTurnstile(token, ip, env) {
  if (!turnstileEnabled(env)) {
    return { ok: true, reason: 'disabled' };
  }

  if (!env.TURNSTILE_SECRET) {
    // Fail closed. A missing secret must never silently disable the check.
    console.error('TURNSTILE_SECRET is not configured');
    return { ok: false, reason: 'misconfigured' };
  }

  if (!token) {
    return { ok: false, reason: 'missing-token' };
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  if (ip) body.set('remoteip', ip);

  let result;
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
    result = await res.json();
  } catch (err) {
    console.error('Turnstile siteverify request failed:', err?.message);
    return { ok: false, reason: 'verification-unavailable' };
  }

  if (!result.success) {
    // Codes are useful in logs, never in the visitor-facing message.
    console.warn('Turnstile rejected token:', (result['error-codes'] || []).join(','));
    return { ok: false, reason: 'rejected' };
  }

  return { ok: true };
}
