/**
 * Server-rendered admin markup.
 *
 * Template literals rather than a static asset directory, and that is a
 * security decision rather than a stylistic one. Cloudflare serves [assets]
 * *before* the fetch handler runs, so a static admin page would be delivered
 * to unauthenticated requests with only the data behind the gate. Rendering
 * here means an unauthorised request receives no admin markup at all — not the
 * structure, not the field names, not a hint of what exists.
 *
 * The same idiom email.js already uses, for the same reason: no build step.
 */

/** Escape for HTML text and quoted attributes. Applied to every interpolation. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root {
    --navy: #0d2340; --navy-soft: #16304f; --gold: #c8a04a; --gold-soft: #e0c07a;
    --ink: #10151c; --muted: #5d6b7d; --line: #dfe5ec; --bg: #f4f6f9;
    --ok: #1c7c4a; --warn: #a8620d; --danger: #a32020;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  header {
    background: var(--navy); color: #fff; padding: 14px 18px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  header .mark { font-weight: 700; letter-spacing: .02em; }
  header .mark span { color: var(--gold); }
  header nav { display: flex; gap: 14px; margin-left: auto; flex-wrap: wrap; }
  header nav a { color: var(--gold-soft); text-decoration: none; font-size: 14px; }
  header nav a[aria-current="page"] { color: #fff; text-decoration: underline; }
  header .who { font-size: 13px; color: #b9c6d6; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 18px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 20px; }
  .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .n { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .card .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 22px; }
  .panel h2 { font-size: 15px; margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--line); background: #fafbfd; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); background: #fafbfd; }
  tbody tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; }
  .pill.confirmed { background: #e4f3ea; color: var(--ok); }
  .pill.waitlist { background: #fdf0dd; color: var(--warn); }
  .pill.cancelled { background: #f6e5e5; color: var(--danger); }
  .med { color: var(--danger); font-weight: 600; font-size: 12px; }
  .empty { padding: 28px 16px; color: var(--muted); text-align: center; font-size: 14px; }
  .notice { background: #fff; border: 1px solid var(--line); border-left: 4px solid var(--gold);
            border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; font-size: 14px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 0 18px 30px; }
  @media (max-width: 640px) {
    th, td { padding: 8px 10px; }
    main { padding: 16px 12px 50px; }
  }
`;

/**
 * Full page shell.
 *
 * No external stylesheet, font, or script: the admin surface must render
 * identically on a phone in a church gym with one bar of signal, and every
 * external request is another thing that can hang there.
 */
export function page({ title, principal, nav = [], current = '', body }) {
  const links = nav
    .map(
      (n) =>
        `<a href="${esc(n.href)}"${n.href === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · TN Saints Admin</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="mark">TN <span>Saints</span> Admin</div>
  <nav>${links}</nav>
  ${principal ? `<div class="who">${esc(principal.displayName)} · ${esc(principal.role)}</div>` : ''}
</header>
<main>
${body}
</main>
<footer>Tennessee Saints Basketball Academy · staff only</footer>
</body>
</html>`;
}

/**
 * Security headers for every admin response.
 *
 * The CSP has no 'unsafe-inline' for scripts and no script source at all,
 * because this page runs none. Styles are inline by necessity (no asset
 * pipeline), which is why script-src is locked down rather than relaxed to
 * match.
 *
 * no-store matters more here than on the public site: a shared or borrowed
 * laptop should not have a roster of children sitting in its back/forward
 * cache after the coach walks away.
 */
export function adminHeaders(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

export function htmlResponse(html, { status = 200, headers = {} } = {}) {
  return new Response(html, { status, headers: adminHeaders(headers) });
}

/**
 * The "you got in, but you are not on the list" page.
 *
 * A bare 403 is the wrong answer here, and the risk register says why: when a
 * coach is refused, the two possible causes — Access rejected them, or Access
 * admitted them and `staff` did not — look identical from the outside and lead
 * to completely different fixes. One is a login problem, the other is a
 * one-line INSERT. Saying which it is, and who to text, turns a blocked evening
 * on the night before an event into a thirty-second fix.
 *
 * This discloses only the email the visitor already authenticated as, so it
 * tells an attacker nothing they did not already supply.
 */
export function notAuthorisedPage(email) {
  return page({
    title: 'Not yet authorised',
    body: `
  <h1>You are signed in, but not yet authorised</h1>
  <p class="sub">Cloudflare let you through. This app does not have your account on its staff list yet.</p>
  <div class="notice">
    <p style="margin:0 0 8px"><strong>Signed in as:</strong> ${esc(email || 'unknown')}</p>
    <p style="margin:0">This is a one-line fix on our side. Text or email Jacob with the address above
    and he can add you in under a minute. Nothing is wrong with your login.</p>
  </div>`,
  });
}
