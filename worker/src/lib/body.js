/**
 * Reading request bodies with a hard size cap.
 *
 * Checking Content-Length first (what /api/register does) is not a cap: a
 * chunked request carries no Content-Length, and request.text() or .json()
 * would then buffer whatever arrives. This reads the stream and stops at the
 * limit, so an oversized body costs at most `maxBytes` of memory and CPU.
 */

export class BodyTooLarge extends Error {}

/** The body as text, or throws BodyTooLarge past `maxBytes`. */
export async function readTextCapped(request, maxBytes) {
  return new TextDecoder().decode(await readBytesCapped(request, maxBytes));
}

/**
 * The exact body bytes, or throws BodyTooLarge past `maxBytes`. For signature
 * checks that must see the bytes as sent (a webhook's CRC-32), not a re-encoding.
 */
export async function readBytesCapped(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

/**
 * A JSON body from a portal page's own fetch(), or null if it is not one.
 * Requiring application/json matters beyond parsing: a cross-site HTML form
 * cannot send that content type without a CORS preflight, which this Worker
 * never grants — one more wall behind the Sec-Fetch-Site check.
 */
export async function readJson(request, maxBytes = 8 * 1024) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return null;
  try {
    const value = JSON.parse(await readTextCapped(request, maxBytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    if (err instanceof BodyTooLarge) throw err;
    return null;
  }
}

/**
 * An HTML form post (application/x-www-form-urlencoded) as a URLSearchParams.
 * Anything else is refused: portal forms are plain HTML forms, and a JSON or
 * multipart body at a form endpoint is not something a portal page sends.
 *
 * @returns {Promise<URLSearchParams | null>} null if the content type is wrong
 */
export async function readForm(request, maxBytes = 8 * 1024) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  return new URLSearchParams(await readTextCapped(request, maxBytes));
}
