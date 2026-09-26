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
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return '';

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
  return new TextDecoder().decode(bytes);
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
