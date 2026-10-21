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

import { BRAND_TOKENS } from '../lib/brand.js';
import { can } from '../auth/staff.js';

/** Escape for HTML text and quoted attributes. Applied to every interpolation. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The one back button used across the admin.
 *
 * A rounded, clearly tappable control with a left arrow, placed at the top of a
 * detail page to return to its list — not a faint text link that is easy to
 * miss. Defined once here (with .backbtn in the shared styles) so a page just
 * calls backButton(href, label); change the look in one place and every page
 * follows. The arrow is an inline SVG using currentColor, so it flips to white
 * on hover with the text and needs no image request.
 */
export function backButton(href, label) {
  return (
    `<a class="backbtn" href="${esc(href)}">` +
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
    `<path d="M19 12H6M12 6l-6 6 6 6" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `<span>${esc(label)}</span></a>`
  );
}

// Colour tokens live in lib/brand.js, shared with the parent portal, with the
// note on why gold is never used as text on white.
const STYLES = `${BRAND_TOKENS}
  * { box-sizing: border-box; }
  /*
   * Reserve the scrollbar's width whether or not the page needs one.
   *
   * Without this, the layout jumps sideways between pages: the player list is
   * short enough to fit the viewport while an evaluation form is roughly twice
   * as tall, so moving between them adds and removes a vertical scrollbar,
   * narrows the viewport by ~15px, and shifts everything centred — including
   * the header — to the left. It reads as the page being broken rather than as
   * a scrollbar appearing.
   *
   * Set on html because that is the scrolling element. Mobile is unaffected
   * either way, since overlay scrollbars take no space; this is for the desktop
   * review sessions where the jump is obvious.
   */
  html { scrollbar-gutter: stable; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  /*
   * The staff header mirrors the public site's navbar: a white bar under a gold
   * rule, with navy pill links that fill in on hover and for the current page.
   * The site's own header CSS lives in index.html — this matches its look
   * without sharing a stylesheet, the same way the colour tokens are kept in
   * sync by hand. (Gold is an accent here, never link text: gold on white fails
   * WCAG, so the pills are navy — see the --gold note above.)
   */
  /*
   * The menu (owner, 2026-10-20): grouped links, a sidebar on wide screens and
   * a Menu button below 960px. The admin runs no script, so the button is a
   * <details> with nothing inside it: the menu is its next sibling, shown
   * while it is open (the sibling combinator, which every browser supports).
   * Every rule is scoped to header.site, because pages have tab bars of their
   * own in <nav> elements.
   */
  .skip { position: absolute; left: -9999px; top: 8px; z-index: 10; padding: 8px 14px; border-radius: 8px;
    background: #fff; color: var(--navy); font-weight: 700; box-shadow: 0 2px 10px rgba(6, 37, 92, .2); }
  .skip:focus { left: 12px; }
  header.site {
    background: #fff;
    border-bottom: 4px solid var(--gold);
    box-shadow: 0 6px 18px rgba(6, 37, 92, .06);
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px;
  }
  header.site .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; min-width: 0; flex: 1 1 auto; }
  header.site .brand img { width: 44px; height: 44px; object-fit: contain; display: block; }
  header.site .mark { font-weight: 800; letter-spacing: .01em; line-height: 1.1;
    font-size: 16px; color: var(--navy); }
  header.site .mark small { display: block; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .12em; color: var(--gold-ink); margin-top: 2px; }
  .menu-btn summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
    min-height: 44px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 999px;
    background: #fff; color: var(--navy); font-size: 15px; font-weight: 700;
  }
  .menu-btn summary::-webkit-details-marker { display: none; }
  .menu-btn summary:focus-visible { outline: 2px solid var(--navy-soft); outline-offset: 2px; }
  .menu-btn[open] summary { background: var(--navy); border-color: var(--navy); color: #fff; }
  .menu-btn summary svg { display: block; }
  .menu-btn .if-open, .menu-btn[open] .if-shut { display: none; }
  .menu-btn[open] .if-open { display: inline; }
  header.site .side-nav { flex: 1 1 100%; padding: 4px 0 6px; }
  .menu-btn:not([open]) ~ .side-nav { display: none; }
  header.site .side-nav ul { list-style: none; margin: 0; padding: 0; }
  header.site .side-nav li a {
    display: block; padding: 10px 12px; border-radius: 8px; font-size: 15px; font-weight: 700;
    color: var(--navy); text-decoration: none; transition: background .15s ease, color .15s ease;
  }
  header.site .side-nav li a:hover, header.site .side-nav li a:focus-visible { background: var(--navy-soft); color: #fff; }
  header.site .side-nav li a[aria-current="page"] { background: var(--navy); color: #fff; }
  header.site .nav-group { margin-top: 12px; }
  header.site .nav-h { margin: 0 0 2px; padding: 0 12px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  header.site .staff-who { margin-top: 14px; padding: 12px 12px 2px; border-top: 1px solid var(--line);
    font-size: 13px; color: var(--muted); }
  header.site .staff-who strong { display: block; color: var(--ink); font-size: 14px; }
  header.site .staff-who a { color: var(--navy); font-weight: 700; }
  header.site .staff-who a[aria-current="page"] { text-decoration: none; }
  /* A phone held sideways or a tablet: the open menu in two balanced columns, no group split. */
  @media (min-width: 480px) and (max-width: 959px) {
    header.site .side-nav { column-count: 2; column-gap: 18px; }
    header.site .nav-group { break-inside: avoid; }
    header.site .nav-top, header.site .staff-who { column-span: all; }
    header.site .nav-group:first-of-type { margin-top: 0; }
  }
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
  /* Back button — a rounded, clearly tappable control at the top of a detail
   * page, rather than a faint text link. Defined here so every page shares one
   * look: change it once and it changes everywhere. */
  .backbtn { display: inline-flex; align-items: center; gap: 7px;
             margin-bottom: 16px; padding: 8px 15px 8px 11px;
             background: #fff; border: 1px solid var(--line); border-radius: 999px;
             color: var(--navy); font-size: 14px; font-weight: 600; text-decoration: none;
             box-shadow: 0 1px 2px rgba(6, 37, 92, .06);
             transition: background .15s ease, border-color .15s ease, color .15s ease; }
  .backbtn:hover { background: var(--navy); border-color: var(--navy); color: #fff; }
  .backbtn:focus-visible { outline: 2px solid var(--navy-soft); outline-offset: 2px; }
  .backbtn svg { display: block; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 0 18px 30px; }
  /* ---------------------------------------------------------------------
   * Narrow screens.
   *
   * A horizontally scrolling five-column table is technically "responsive"
   * and practically unusable: the player's name scrolls out of view exactly
   * when you press the button that acts on them, which on a screen with
   * Cancel and Delete is how the wrong child gets deleted.
   *
   * So below 720px the data tables stop being tables. Each row becomes a
   * card, and every cell carries its own label from its data-label attribute,
   * so nothing depends on a header that is no longer beside it.
   * ------------------------------------------------------------------- */
  @media (max-width: 720px) {
    main { padding: 16px 12px 50px; }
    h1 { font-size: 20px; }

    table.stack thead { position: absolute; width: 1px; height: 1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    table.stack tbody tr {
      display: block; border: 1px solid var(--line); border-radius: 10px;
      padding: 4px 0; margin: 0 0 10px; background: #fff;
    }
    table.stack td {
      display: flex; gap: 12px; align-items: baseline; white-space: normal;
      border: 0; padding: 7px 14px; text-align: left;
    }
    table.stack td::before {
      content: attr(data-label); flex: 0 0 42%; max-width: 42%;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .05em; color: var(--muted);
    }
    /* Rows whose only content is the name read better as a heading. */
    table.stack td[data-label="Player"] { display: block; padding-top: 11px; }
    table.stack td[data-label="Player"]::before { display: none; }
    /* Action cells: full-width, thumb-sized, stacked rather than crowded. */
    table.stack td[data-label="Admin"], table.stack td[data-label="Decision"] { flex-wrap: wrap; }
    table.stack td[data-label="Admin"] button,
    table.stack td[data-label="Decision"] button { flex: 1 1 42%; padding: 11px 10px; }
    .scroll { overflow-x: visible; }

    .cards { grid-template-columns: repeat(2, 1fr); }
    .card .n { font-size: 22px; }
    .bigbtn { width: 100%; }
    .toolbar { gap: 10px; }
  }

  @media (max-width: 400px) {
    .cards { grid-template-columns: 1fr; }
  }

  /* Last, so it wins over the base main and footer rules above. */
  /* Wide screens: the menu is a sidebar, always open, every page one click away. */
  @media (min-width: 960px) {
    body { display: grid; grid-template-columns: 240px minmax(0, 1fr); grid-template-rows: 1fr auto; min-height: 100vh; }
    header.site {
      grid-column: 1; grid-row: 1 / 3; position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
      flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 0; padding: 16px 12px 20px;
      border-bottom: 0; border-right: 1px solid var(--line); box-shadow: none;
    }
    header.site .brand { flex: 0 0 auto; padding: 0 6px 14px; margin-bottom: 12px; border-bottom: 4px solid var(--gold); }
    .menu-btn { display: none; }
    .menu-btn:not([open]) ~ .side-nav, header.site .side-nav { display: block; flex: 0 0 auto; padding: 0; }
    header.site .side-nav li a { padding: 7px 12px; font-size: 14px; }
    main { grid-column: 2; width: 100%; max-width: 1100px; margin: 0; padding: 24px 28px 60px; }
    footer { grid-column: 2; text-align: left; padding: 0 28px 30px; }
  }
`;

// Three bars; the word beside it says what it does.
const MENU_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/**
 * Full page shell.
 *
 * No external stylesheet, font, or script: the admin surface must render
 * identically on a phone in a church gym with one bar of signal, and every
 * external request is another thing that can hang there.
 */
export function page({ title, principal, nav = [], current = '', body, extraStyles = '' }) {
  // A link to a page this person cannot open is noise; leave it out, and a
  // group with nothing left in it with it.
  const shown = nav.filter((n) => !n.cap || n.cap === 'staff' || !principal || can(principal, n.cap));
  const here = (n) => (n.href === current ? ' aria-current="page"' : '');
  const item = (n) => `<li><a href="${esc(n.href)}"${here(n)}>${esc(n.label)}</a></li>`;
  const top = shown.filter((n) => !n.group && !n.account);
  const groups = [...new Set(shown.filter((n) => n.group).map((n) => n.group))];
  const menu = [
    top.length ? `<ul class="nav-top">${top.map(item).join('')}</ul>` : '',
    ...groups.map((g, i) => `<div class="nav-group"><p class="nav-h" id="nav-g${i}">${esc(g)}</p>
      <ul aria-labelledby="nav-g${i}">${shown.filter((n) => n.group === g).map(item).join('')}</ul></div>`),
  ].join('');
  const account = shown.filter((n) => n.account).map((n) => ` · <a href="${esc(n.href)}"${here(n)}>${esc(n.label)}</a>`).join('');
  const who = principal
    ? `<div class="staff-who"><strong>${esc(principal.displayName)}</strong>${esc(principal.role)}${account}</div>`
    : '';
  // Staff who can open the brief start there; everyone else at their home.
  const home = shown.some((n) => n.href === '/brief') ? '/brief' : '/';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · TN Saints Admin</title>
<style>${STYLES}${extraStyles}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
  <a class="brand" href="${home}">
    <img src="/logo.png" width="44" height="44" alt="Tennessee Saints">
    <div class="mark">Tennessee Saints<small>Staff Portal</small></div>
  </a>
  ${menu || who ? `<details class="menu-btn"><summary aria-controls="main-menu">${MENU_ICON}<span class="if-shut">Menu</span><span class="if-open">Close</span></summary></details>
  <nav class="side-nav" id="main-menu" aria-label="Main menu">${menu}${who}</nav>` : ''}
</header>
<main id="main">
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
    // Version-controlled transport security rather than dashboard-dependent.
    // The zone almost certainly forces HTTPS already, but pinning it here means
    // the admin surface's transport guarantee travels with the code and cannot
    // be lost to a Cloudflare setting someone toggles.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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
