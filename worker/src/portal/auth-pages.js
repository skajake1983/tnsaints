/**
 * Sign-in pages. Markup only; the decisions live in auth/magic.js.
 */

import { esc, portalPage, portalResponse, portalHeaders, field, errorSummary } from './ui.js';
import { inlineScriptCsp } from '../lib/csp.js';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * The sign-in page loads Cloudflare Turnstile, so it alone allows that one
 * script origin and its frame. Everything else stays 'none'.
 */
const SIGNIN_CSP =
  "default-src 'none'; " +
  `script-src ${TURNSTILE_ORIGIN}; frame-src ${TURNSTILE_ORIGIN}; ` +
  "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Offscreen honeypot: people never see or fill it; naive bots do. */
const HONEYPOT = `<div style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden" aria-hidden="true">
  <label for="company">Company</label><input id="company" name="company" type="text" tabindex="-1" autocomplete="off">
</div>`;

export function signInPage(rc, { email = '', errors = [], siteKey = '', turnstile = true, signupOpen = false, status = 200 } = {}) {
  const emailError = errors.find((e) => e.id === 'email')?.message || '';
  const body = `<h1>Sign in</h1>
<p class="lede">We'll email you a sign-in link. There's no password to remember.</p>
${errorSummary(errors)}
<form method="post" action="${esc(rc.url('/auth/email'))}" novalidate>
  ${field({ id: 'email', label: 'Email address', type: 'email', value: email, required: true,
    autocomplete: 'email', inputmode: 'email', error: emailError,
    hint: 'Use the email you gave the academy.' })}
  ${HONEYPOT}
  ${turnstile ? `<div class="cf-turnstile field" data-sitekey="${esc(siteKey)}" data-theme="light"></div>` : ''}
  <button class="btn" type="submit">Email me a sign-in link</button>
</form>
<div class="panel" style="margin-top:24px">
  ${signupOpen
    ? '<p style="margin:0">New to the portal? Enter your email above and the link will set up your family account.</p>'
    : '<p style="margin:0">The portal is open to invited families for now. If you\'d like an invitation, email <a href="mailto:info@tnsaints.com">info@tnsaints.com</a>.</p>'}
</div>
${turnstile ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : ''}`;

  return portalResponse(portalPage({ rc, title: 'Sign in', body }), {
    status,
    headers: { 'Content-Security-Policy': SIGNIN_CSP },
  });
}

/**
 * Shown for every well-formed request, whether or not the address has an
 * account, so the page cannot be used to find out who is a customer.
 */
export function checkEmailPage(rc, cookies = []) {
  const body = `<h1>Check your email</h1>
<p class="lede">If that address can use the parent portal, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
<div class="panel">
  <p style="margin-top:0">Nothing after a few minutes? Check your junk or spam folder, then try again.</p>
  <p style="margin-bottom:0"><a href="${esc(rc.url('/'))}">Back to sign in</a></p>
</div>`;
  return withCookies(portalResponse(portalPage({ rc, title: 'Check your email', body })), cookies);
}

export function tooManyPage(rc) {
  const body = `<h1>Please wait a few minutes</h1>
<p class="lede">There have been too many sign-in attempts from this connection. Try again in 15 minutes.</p>
<p><a href="${esc(rc.url('/'))}">Back to sign in</a></p>`;
  return portalResponse(portalPage({ rc, title: 'Too many attempts', body }), {
    status: 429,
    headers: { 'Retry-After': '900' },
  });
}

/**
 * The link's landing page. INERT: it never signs anyone in by being opened.
 *
 * Mail security scanners (Outlook Safe Links, Gmail, Mimecast) open links and
 * run their JavaScript. A page that signed in on load, or auto-submitted, would
 * burn the single-use link before the parent ever saw it — the same lesson as
 * cancel.html. So the script only moves the token from the URL fragment into
 * the form and wipes it from the address bar and history; the person must
 * press Continue.
 *
 * The token is in the fragment (#t=...) because fragments are never sent to a
 * server: not to this Worker's logs, not in a Referer, not to a proxy.
 */
const VERIFY_SCRIPT = `(function () {
  var form = document.getElementById('verify');
  var missing = document.getElementById('missing');
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  if (!m) { form.hidden = true; missing.hidden = false; return; }
  form.elements.t.value = m[1];
  if (window.history && history.replaceState) history.replaceState(null, '', location.pathname);
})();`;

export async function verifyPage(rc) {
  const body = `<h1>Finish signing in</h1>
<form id="verify" method="post" action="${esc(rc.url('/auth/email/verify'))}">
  <input type="hidden" name="t" value="">
  <p class="lede">Press Continue to sign in to the Tennessee Saints parent portal.</p>
  <button class="btn" type="submit">Continue</button>
</form>
<div id="missing" hidden>
  <p class="lede">This sign-in link is incomplete. Links sometimes get cut off when copied.</p>
  <p><a class="btn" href="${esc(rc.url('/'))}">Get a new link</a></p>
</div>
<noscript><div class="notice">This page needs JavaScript turned on to finish signing in. Turn it on and reload,
or <a href="${esc(rc.url('/'))}">request a new link</a> from another browser.</div></noscript>
<script>${VERIFY_SCRIPT}</script>`;

  return portalResponse(portalPage({ rc, title: 'Finish signing in', body }), {
    headers: { 'Content-Security-Policy': await inlineScriptCsp(VERIFY_SCRIPT) },
  });
}

/**
 * The link was opened in a different browser from the one that asked for it.
 *
 * That is normal (asked on a laptop, opened on a phone) but it is also exactly
 * what a login-CSRF attack looks like: someone sends you THEIR link so that you
 * end up signed in as them and type your child's details into their account.
 * Naming the account (partly masked) before continuing defeats that.
 */
export function confirmPage(rc, token, maskedEmail) {
  const body = `<h1>Is this you?</h1>
<p class="lede">You're about to sign in as <strong>${esc(maskedEmail)}</strong>.</p>
<p>If you asked for this link from another device, that's fine — continue. If you didn't ask for it, close this page.</p>
<form method="post" action="${esc(rc.url('/auth/email/verify'))}">
  <input type="hidden" name="t" value="${esc(token)}">
  <input type="hidden" name="confirm" value="1">
  <button class="btn" type="submit">Yes, continue as ${esc(maskedEmail)}</button>
</form>`;
  return portalResponse(portalPage({ rc, title: 'Confirm sign-in', body }));
}

export function linkProblemPage(rc) {
  const body = `<h1>That link has expired</h1>
<p class="lede">Sign-in links work once and expire after 15 minutes.</p>
<p><a class="btn" href="${esc(rc.url('/'))}">Get a new link</a></p>`;
  return portalResponse(portalPage({ rc, title: 'Link expired', body }), { status: 400 });
}

/** Signed-in landing. The family dashboard replaces the placeholder in P1.7. */
export function homePage(rc, session) {
  const body = `<h1>Welcome</h1>
<p class="lede">You're signed in as <strong>${esc(session.email)}</strong>.</p>
<div class="panel">
  <p style="margin:0">Your family dashboard is coming next: add your children, keep medical and emergency
  details up to date, and apply to the academy.</p>
</div>
<form method="post" action="${esc(rc.url('/auth/signout'))}">
  <button class="btn secondary" type="submit">Sign out</button>
</form>`;
  return portalResponse(portalPage({ rc, title: 'Your family', body }));
}

/** 303 See Other: the post-redirect-get step after a form. */
export function redirect(location, cookies = []) {
  const headers = new Headers(portalHeaders({ Location: location }));
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

/** Add Set-Cookie headers to a response (each cookie its own header). */
export function withCookies(response, cookies) {
  for (const c of cookies) response.headers.append('Set-Cookie', c);
  return response;
}
