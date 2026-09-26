/**
 * Feature flags, kill switches and modes, read from wrangler.toml [vars].
 *
 * STRICT BY DESIGN. A flag is on only when it says exactly "true" (or is the
 * TOML boolean true), off only when it says exactly "false". Anything else --
 * "yes", "False", "1", a typo -- is treated as unset and falls back to the
 * caller's default, and the misspelling is logged once per isolate so it does
 * not sit unnoticed.
 *
 * Each caller chooses its default, and a security control defaults CLOSED: a
 * missing or mangled setting must never be the thing that switches a
 * protection off.
 *
 * The older switches (TURNSTILE_ENABLED, ROSTER_DIGEST_ENABLED,
 * SEND_PARENT_CONFIRMATION) predate this module and keep their own lenient,
 * case-insensitive parsing, because changing how a live switch reads is a
 * behaviour change in its own right. New switches use these helpers.
 */

const warned = new Set();

function warnInvalid(name) {
  if (warned.has(name)) return;
  warned.add(name);
  // The name only. Values here are not secret, but nothing is gained by
  // echoing whatever landed in a misnamed variable.
  console.warn(JSON.stringify({ event: 'flag_invalid', name }));
}

function isUnset(raw) {
  return raw === undefined || raw === null || raw === '';
}

/** A boolean switch. Exactly "true"/"false" (or TOML booleans); otherwise `fallback`. */
export function flag(env, name, fallback) {
  const raw = env[name];
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  if (!isUnset(raw)) warnInvalid(name);
  return fallback;
}

/** One of a fixed set of string modes; otherwise `fallback`. */
export function choice(env, name, allowed, fallback) {
  const raw = env[name];
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  if (!isUnset(raw)) warnInvalid(name);
  return fallback;
}
