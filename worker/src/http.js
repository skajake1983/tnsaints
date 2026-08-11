/**
 * Shared HTTP helpers: CORS, JSON responses, and client-safe errors.
 */

/**
 * Only ever reflects an origin that is explicitly allow-listed.
 *
 * Deliberately no `*` fallback: a wildcard on an endpoint that mutates
 * capacity would let any site on the internet POST registrations.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

export function json(data, { status = 200, cors = {}, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors,
      ...headers,
    },
  });
}

/**
 * Client-facing error. `message` is shown to the visitor, so it must never
 * carry a stack trace, SQL text, or upstream provider detail.
 */
export function errorResponse(message, status, cors, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status, cors });
}

/**
 * Salted SHA-256 of the visitor IP. Rate limiting needs to correlate repeat
 * requests, but storing raw addresses would put PII in the database.
 */
export async function hashIp(ip, salt) {
  // A missing salt is a hard error, never a silent fallback.
  //
  // `${salt || 'unsalted'}` used to hash every visitor with a globally-known
  // constant the moment IP_HASH_SALT was unset or mistyped — the opposite of
  // fail-closed, and invisible. If the salt is public, a hashed IP is
  // reversible for any small address space. Refuse to hash rather than hash
  // insecurely; the caller aborts the request instead of writing a weak hash.
  if (!salt) {
    throw new Error('IP_HASH_SALT is not configured; refusing to hash with a known constant.');
  }
  const bytes = new TextEncoder().encode(`${salt}:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '';
}

/**
 * Rows to RFC 4180 CSV. Shared by the admin export endpoint and the scheduled
 * roster email so both produce byte-identical files.
 */
export function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);

  const escape = (v) => {
    let s = v === null || v === undefined ? '' : String(v);

    // Neutralise spreadsheet formula injection.
    //
    // A registration field (player_notes, medical_notes) is validated by length
    // only, so an anonymous POST can store a value beginning with = + - @. This
    // CSV is emailed to staff daily with the instruction "open in Excel or
    // Google Sheets", and in Sheets a leading =IMPORTDATA(...) auto-executes on
    // open and can exfiltrate adjacent cells — every child's medical notes and
    // contacts — to an attacker URL. Quote-wrapping does NOT stop it; the cell
    // must not START with a trigger. A leading apostrophe forces the cell to
    // text in every spreadsheet and is invisible to a normal reader.
    if (/^[=+\-@]/.test(s)) {
      s = `'${s}`;
    }

    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\r\n');
}

/** Base64 for Resend attachments. Handles non-ASCII without corrupting it. */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
