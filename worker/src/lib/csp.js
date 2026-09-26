/**
 * Content-Security-Policy for server-rendered pages that carry one inline script.
 *
 * Every admin page with behaviour ships its script inline and allows it by
 * SHA-256 hash instead of 'unsafe-inline'. These pages render coach-authored
 * text, parent-typed text and children's names, and the session behind them can
 * read medical notes. If escaping ever has a hole, 'unsafe-inline' would let the
 * injected script run; a hash-only script-src means it cannot, because its hash
 * will not match.
 *
 * This used to be copied into four UI modules. It lives here so the portal gets
 * the same policy without a fifth copy, and so a change to the policy is made
 * once. The admin headers must stay byte-identical across that refactor; the
 * string below is exactly what the four copies produced.
 */

/** Hash per script source, per isolate. Scripts are module constants, so this stays tiny. */
const hashes = new Map();

/** `'sha256-<base64>'` for a script's exact source text, as CSP script-src expects. */
export async function scriptHash(source) {
  const cached = hashes.get(source);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  const hash = `'sha256-${btoa(binary)}'`;
  hashes.set(source, hash);
  return hash;
}

/**
 * The policy for a page whose only script is `source`, inlined verbatim.
 *
 * The page must emit `<script>${source}</script>` with nothing added inside the
 * tags, or the browser's hash of it will not match and the script will not run.
 */
export async function inlineScriptCsp(source) {
  const hash = await scriptHash(source);
  return (
    "default-src 'none'; " +
    `script-src ${hash}; ` +
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}
