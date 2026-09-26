/**
 * Server-rendered parent portal markup: the page shell, form helpers, and the
 * pages every request can end on (not found, maintenance).
 *
 * Built for a parent on a phone, often in a car park, sometimes on one bar of
 * signal, sometimes with a screen reader or text at 200%:
 *   - no external stylesheet, font or script; nothing to hang on a bad network
 *   - plain HTML forms that work with no JavaScript at all (post-redirect-get)
 *   - labels above inputs, 16px inputs (no iOS zoom), 44px tap targets,
 *     visible focus, a skip link, real landmarks
 *   - errors listed in a summary at the top that links to each field, and
 *     repeated beside the field, so neither sighted nor screen-reader users have
 *     to hunt for what went wrong
 *
 * Same escaping discipline as the admin: every interpolation goes through esc().
 */

import { esc } from '../admin/ui.js';
import { BRAND_TOKENS } from '../lib/brand.js';

export { esc };

const STYLES = `${BRAND_TOKENS}
  * { box-sizing: border-box; }
  html { scrollbar-gutter: stable; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  a { color: var(--navy-soft); }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 3px solid var(--navy-soft); outline-offset: 2px;
  }
  .skip { position: absolute; left: -9999px; top: 0; background: var(--navy); color: #fff;
          padding: 10px 16px; border-radius: 0 0 8px 0; z-index: 10; }
  .skip:focus { left: 0; }
  header { background: #fff; border-bottom: 4px solid var(--gold); box-shadow: 0 6px 18px rgba(6, 37, 92, .06); }
  header .nav-inner { max-width: 760px; margin: 0 auto; padding: 10px 18px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; min-width: 0; }
  header .brand img { width: 44px; height: 44px; object-fit: contain; display: block; }
  header .mark { font-weight: 800; line-height: 1.1; font-size: 16px; color: var(--navy); }
  header .mark small { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .12em; color: var(--gold-ink); margin-top: 2px; }
  header nav { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
  header nav a, header nav button {
    padding: 10px 14px; border-radius: 999px; font: inherit; font-size: 15px; font-weight: 700;
    color: var(--navy); text-decoration: none; background: none; border: 0; cursor: pointer; min-height: 44px;
  }
  header nav a:hover, header nav button:hover { background: var(--navy-soft); color: #fff; }
  header nav a[aria-current="page"] { background: var(--navy); color: #fff; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 18px 60px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 8px; color: var(--navy); }
  h2 { font-size: 19px; margin: 28px 0 8px; }
  .lede { color: var(--muted); margin: 0 0 22px; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 18px; }
  .notice { background: #fff; border: 1px solid var(--line); border-left: 4px solid var(--gold);
            border-radius: 8px; padding: 14px 16px; margin: 0 0 18px; }
  .notice.test { border-left-color: var(--warn); }
  .field { margin: 0 0 18px; }
  .field label, .field legend { display: block; font-weight: 700; margin-bottom: 6px; }
  .field .hint { display: block; color: var(--muted); font-size: 15px; margin: -2px 0 6px; }
  .field .req { color: var(--danger); font-weight: 700; }
  .field .opt { color: var(--muted); font-weight: 400; font-size: 15px; }
  .field input, .field select, .field textarea {
    width: 100%; font: inherit; font-size: 17px; padding: 11px 12px; min-height: 48px;
    border: 1px solid #9aa7bb; border-radius: 8px; background: #fff; color: var(--ink);
  }
  .field.has-error input, .field.has-error select, .field.has-error textarea { border: 2px solid var(--danger); }
  .field .error { display: block; color: var(--danger); font-weight: 700; font-size: 15px; margin: 0 0 6px; }
  .errors { border: 3px solid var(--danger); border-radius: 10px; background: #fff; padding: 14px 18px; margin: 0 0 22px; }
  .errors h2 { margin: 0 0 8px; font-size: 18px; color: var(--danger); }
  .errors ul { margin: 0; padding-left: 20px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px;
         padding: 12px 22px; border-radius: 10px; border: 0; font: inherit; font-weight: 700;
         background: var(--navy); color: #fff; text-decoration: none; cursor: pointer; }
  .btn:hover { background: var(--navy-soft); }
  .btn.secondary { background: #fff; color: var(--navy); border: 2px solid var(--navy); }
  fieldset.field { border: 0; padding: 0; margin: 0 0 18px; min-width: 0; }
  fieldset.field legend { padding: 0; }
  .choice { display: flex; align-items: center; gap: 10px; min-height: 44px; font-weight: 400; margin: 2px 0; cursor: pointer; }
  .field .choice input { width: 22px; height: 22px; min-height: 0; margin: 0; flex: none; }
  .field textarea { min-height: 96px; resize: vertical; }
  /* Badge text colours are darker than the admin's pills so they clear AA on their tints. */
  .badge { display: inline-block; font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .badge.ok { background: #e4f3ea; color: #145c37; }
  .badge.warn { background: #fdf0dd; color: #7a4a09; }
  .cards-list { list-style: none; margin: 0 0 16px; padding: 0; }
  .cards-list .item { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
                      padding: 12px 0; border-bottom: 1px solid var(--line); }
  .cards-list .item:last-child { border-bottom: 0; }
  .item-title { font-weight: 700; font-size: 18px; }
  .item-sub { color: var(--muted); font-size: 15px; }
  ul.plain, ol.plain { margin: 0 0 12px; padding-left: 20px; }
  header nav form { margin: 0; }
  footer { color: var(--muted); font-size: 14px; text-align: center; padding: 0 18px 32px; }
  footer a { color: var(--muted); }
  @media (max-width: 560px) {
    main { padding: 18px 14px 50px; }
    h1 { font-size: 23px; }
    .btn { width: 100%; }
    header nav { width: 100%; margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/**
 * The request context every page needs.
 *
 * `base` is '' in production and '/__portal' behind the local development
 * door, so every link and form action is built with rc.url() and works in both.
 * A bare href="/family" would leave the portal locally and land on the API.
 */
export function requestContext({ base = '', siteUrl = 'https://tnsaints.com', testMode = false } = {}) {
  const trimmed = String(siteUrl).replace(/\/$/, '');
  return {
    base,
    siteUrl: trimmed,
    testMode,
    url: (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`,
  };
}

/**
 * Full page shell.
 *
 * @param {object} o
 * @param {ReturnType<typeof requestContext>} o.rc
 * @param {string} o.title     page title, before " · Tennessee Saints"
 * @param {string} o.body      already-escaped HTML
 * @param {Array<{href: string, label: string}>} [o.nav]  portal-relative hrefs
 * @param {string} [o.current] the nav href of this page
 * @param {boolean} [o.signedIn] show Sign out in the header
 */
export function portalPage({ rc, title, body, nav = [], current = '', signedIn = false }) {
  const links = nav
    .map(
      (n) =>
        `<a href="${esc(rc.url(n.href))}"${n.href === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Tennessee Saints</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header>
  <div class="nav-inner">
    <a class="brand" href="${esc(rc.url('/'))}">
      <img src="${esc(rc.url('/logo.png'))}" width="44" height="44" alt="">
      <div class="mark">Tennessee Saints<small>Parent Portal</small></div>
    </a>
    ${links || signedIn ? `<nav aria-label="Portal">${links}${signedIn ? `<form method="post" action="${esc(rc.url('/auth/signout'))}"><button type="submit">Sign out</button></form>` : ''}</nav>` : ''}
  </div>
</header>
<main id="main" tabindex="-1">
${rc.testMode ? '<div class="notice test" role="note"><strong>Test mode.</strong> Payments on this site are simulated; no card is charged.</div>' : ''}
${body}
</main>
<footer>
  Tennessee Saints Basketball Academy ·
  <a href="${esc(rc.siteUrl)}/privacy-policy.html">Privacy</a> ·
  <a href="mailto:info@tnsaints.com">info@tnsaints.com</a>
</footer>
</body>
</html>`;
}

/**
 * Security headers for every portal response. Same baseline as the admin, plus:
 *   - Permissions-Policy: the portal needs no camera, microphone, location or
 *     payment-request API; a successful injection should not get them either.
 *   - COOP same-origin: no cross-origin window can keep a handle on this one.
 *     (The pay page relaxes this to same-origin-allow-popups for PayPal.)
 *   - X-Robots-Tag: family pages never belong in a search index.
 */
export function portalHeaders(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  };
}

export function portalResponse(html, { status = 200, headers = {} } = {}) {
  return new Response(html, { status, headers: portalHeaders(headers) });
}

/**
 * One form field: label, optional hint, inline error, and the ARIA that ties
 * them together. `error` also drives the summary built by errorSummary().
 */
export function field({ id, label, type = 'text', value = '', required = false, hint = '', error = '',
  autocomplete = '', inputmode = '', attrs = '' }) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return `<div class="field${error ? ' has-error' : ''}">
  <label for="${esc(id)}">${esc(label)} ${required ? '<span class="req">(required)</span>' : '<span class="opt">(optional)</span>'}</label>
  ${hint ? `<span class="hint" id="${esc(id)}-hint">${esc(hint)}</span>` : ''}
  ${error ? `<span class="error" id="${esc(id)}-error">${esc(error)}</span>` : ''}
  <input id="${esc(id)}" name="${esc(id)}" type="${esc(type)}" value="${esc(value)}"${required ? ' required aria-required="true"' : ''}${
    error ? ' aria-invalid="true"' : ''}${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}${
    autocomplete ? ` autocomplete="${esc(autocomplete)}"` : ''}${inputmode ? ` inputmode="${esc(inputmode)}"` : ''}${attrs ? ` ${attrs}` : ''}>
</div>`;
}

/**
 * The error summary: first thing on the page after a failed submit, announced
 * by screen readers (role="alert"), each item a link to its field.
 *
 * @param {Array<{id: string, message: string}>} errors
 */
export function errorSummary(errors) {
  if (!errors || !errors.length) return '';
  const items = errors.map((e) => `<li><a href="#${esc(e.id)}">${esc(e.message)}</a></li>`).join('');
  return `<div class="errors" role="alert" tabindex="-1">
  <h2>There ${errors.length === 1 ? 'is a problem' : `are ${errors.length} problems`} to fix</h2>
  <ul>${items}</ul>
</div>`;
}

/**
 * Not found — and also "not yours". A request for another family's child, and
 * a request for a child who does not exist, get byte-identical answers, so the
 * portal never confirms that an id belongs to someone.
 */
export function notFoundResponse(rc) {
  return portalResponse(
    portalPage({
      rc,
      title: 'Page not found',
      body: `<h1>We couldn't find that page</h1>
<p class="lede">The link may be old, or the page may have moved.</p>
<p><a class="btn" href="${esc(rc.url('/'))}">Go to the parent portal</a></p>`,
    }),
    { status: 404 }
  );
}

/**
 * The portal is switched off (PORTAL_ENABLED is not "true"). Every path gets
 * this, with 503 and Retry-After, so nothing behind it is reachable and search
 * engines treat it as temporary.
 */
export function maintenanceResponse(rc) {
  return portalResponse(
    portalPage({
      rc,
      title: 'Parent portal',
      body: `<h1>The parent portal isn't open right now</h1>
<p class="lede">We're getting it ready. Please check back soon.</p>
<div class="panel">
  <p style="margin-top:0">In the meantime you can reach us at
  <a href="mailto:info@tnsaints.com">info@tnsaints.com</a>, or visit
  <a href="${esc(rc.siteUrl)}">tnsaints.com</a>.</p>
</div>`,
    }),
    { status: 503, headers: { 'Retry-After': '3600' } }
  );
}

function labelTag(id, label, required) {
  return `<label for="${esc(id)}">${esc(label)} ${required ? '<span class="req">(required)</span>' : '<span class="opt">(optional)</span>'}</label>`;
}

function describedBy(id, hint, error) {
  return [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
}

/** A <select>. `options` is a list of [value, label]. */
export function selectField({ id, label, options, value = '', required = false, hint = '', error = '', placeholder = 'Choose…' }) {
  const d = describedBy(id, hint, error);
  const opts = [`<option value="">${esc(placeholder)}</option>`]
    .concat(options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`))
    .join('');
  return `<div class="field${error ? ' has-error' : ''}">
  ${labelTag(id, label, required)}
  ${hint ? `<span class="hint" id="${esc(id)}-hint">${esc(hint)}</span>` : ''}
  ${error ? `<span class="error" id="${esc(id)}-error">${esc(error)}</span>` : ''}
  <select id="${esc(id)}" name="${esc(id)}"${required ? ' required aria-required="true"' : ''}${error ? ' aria-invalid="true"' : ''}${d ? ` aria-describedby="${esc(d)}"` : ''}>${opts}</select>
</div>`;
}

/** A multi-line text field. */
export function textareaField({ id, label, value = '', required = false, hint = '', error = '', rows = 4, maxlength = 2000 }) {
  const d = describedBy(id, hint, error);
  return `<div class="field${error ? ' has-error' : ''}">
  ${labelTag(id, label, required)}
  ${hint ? `<span class="hint" id="${esc(id)}-hint">${esc(hint)}</span>` : ''}
  ${error ? `<span class="error" id="${esc(id)}-error">${esc(error)}</span>` : ''}
  <textarea id="${esc(id)}" name="${esc(id)}" rows="${rows}" maxlength="${maxlength}"${required ? ' aria-required="true"' : ''}${error ? ' aria-invalid="true"' : ''}${d ? ` aria-describedby="${esc(d)}"` : ''}>${esc(value)}</textarea>
</div>`;
}

/**
 * Radio buttons in a fieldset, so a screen reader announces the question with
 * each option. The first option carries the id, so an error-summary link lands
 * on the group.
 */
export function radioGroup({ id, legend, options, value = '', required = false, hint = '', error = '' }) {
  const radios = options
    .map(([v, l], i) => `<label class="choice"><input type="radio" name="${esc(id)}" value="${esc(v)}"${i === 0 ? ` id="${esc(id)}"` : ''}${
      String(v) === String(value) ? ' checked' : ''}${required ? ' required' : ''}> ${esc(l)}</label>`)
    .join('');
  return `<fieldset class="field${error ? ' has-error' : ''}"${error ? ` aria-describedby="${esc(id)}-error"` : ''}>
  <legend>${esc(legend)} ${required ? '<span class="req">(required)</span>' : ''}</legend>
  ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  ${error ? `<span class="error" id="${esc(id)}-error">${esc(error)}</span>` : ''}
  ${radios}
</fieldset>`;
}
