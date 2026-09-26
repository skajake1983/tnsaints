"""Parent sign-in by email link, sessions, sign-out (src/auth/magic.js, session.js).

Asserted in the direction that matters for each defence:

  - the request page answers identically for known, unknown and disabled
    addresses, and only a real, active account is sent anything
  - the link token lives in the URL fragment, is stored only as a hash, works
    once, and expires
  - the landing page never signs anyone in by being opened
  - a link opened in another browser names the account and asks first
  - the session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, and the
    database never holds its value
  - cross-site posts are refused outright (the portal has no legacy clients,
    so both CSRF layers are enforced from day one)
  - limits per address and per connection hold
  - sign-out and expiry end the session

Mail goes to a loopback sink this file starts; nothing leaves the machine.
Runs with PORTAL_SIGNUP_ENABLED unset (the invite-only pilot). If .dev.vars
turns signup on, the self-signup section runs instead of the pilot section.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import wrangler_local
from _harness import preflight, _dev_vars

BASE = "http://127.0.0.1:8787"
preflight(BASE)

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = "/__portal"
SINK_PORT = 8799
SAME_ORIGIN = {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8787"}

settings = _dev_vars()
for key, want in (("DEV_PORTAL", "true"), ("PORTAL_ENABLED", "true")):
    if settings.get(key) != want:
        sys.exit(f"\nREFUSING TO RUN.\n  worker/.dev.vars needs {key}={want}\n")
if len(settings.get("AUTH_PEPPER", "")) < 32:
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs AUTH_PEPPER (32+ random characters):\n"
             "      python -c \"import secrets; print('AUTH_PEPPER=' + secrets.token_urlsafe(36))\" >> .dev.vars\n")
SIGNUP_OPEN = settings.get("PORTAL_SIGNUP_ENABLED") == "true"

passed, failed = [], []
captured = []

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    if cond or not detail:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    else:
        print(f"  FAIL  {label}   {str(detail).encode('ascii', 'replace').decode('ascii')[:300]}")


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            captured.append(json.loads(raw))
        except json.JSONDecodeError:
            captured.append({"unparseable": raw[:300]})
        body = json.dumps({"id": f"sink-{len(captured)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def sql(command):
    try:
        return json.loads(wrangler_local(command, json_output=True))[0]["results"]
    except Exception:
        return []


def request(method, path, fields=None, cookies=None, headers=None, ip="10.40.0.1", content_type=None):
    data = None
    if fields is not None:
        data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", content_type or "application/x-www-form-urlencoded")
    req.add_header("CF-Connecting-IP", ip)
    if cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = OPENER.open(req)
    except urllib.error.HTTPError as e:
        r = e
    body = r.read().decode("utf-8", "replace")
    set_cookies = r.headers.get_all("Set-Cookie") or []
    return r.status if hasattr(r, "status") else r.code, dict(r.headers), set_cookies, body


def post(path, fields, cookies=None, ip="10.40.0.1", headers=None):
    return request("POST", path, fields, cookies, {**SAME_ORIGIN, **(headers or {})}, ip)


def cookie_value(set_cookies, name):
    for c in set_cookies:
        if c.startswith(name + "="):
            return c.split(";", 1)[0].split("=", 1)[1]
    return None


def cookie_line(set_cookies, name):
    return next((c for c in set_cookies if c.startswith(name + "=")), "")


def settle(n, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline and len(captured) < n:
        time.sleep(0.1)
    time.sleep(0.6)


def ask_link(email, cookies=None, ip="10.40.0.1"):
    return post(P + "/auth/email", {"email": email, "cf-turnstile-response": "d", "company": ""}, cookies, ip)


def token_from(mail):
    m = re.search(r"/auth/email/verify#t=([A-Za-z0-9_-]{43})", mail.get("text", "") + mail.get("html", ""))
    return m.group(1) if m else None


server = ThreadingHTTPServer(("127.0.0.1", SINK_PORT), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"\n  local mail sink listening on 127.0.0.1:{SINK_PORT} — nothing leaves this machine")

try:
    for t in ["sessions", "auth_login_tokens", "rate_limits", "account_identities", "household_members", "accounts"]:
        sql(f"DELETE FROM {t}")
    sql("DELETE FROM email_budget")
    NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    sql(f"INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES "
        f"('Parent@Example.com', 'parent@example.com', {NOW}, {NOW}), "
        f"('other@example.com', 'other@example.com', {NOW}, {NOW})")
    sql(f"INSERT INTO accounts (email, email_norm, status, created_at, updated_at) VALUES "
        f"('disabled@example.com', 'disabled@example.com', 'disabled', {NOW}, {NOW})")
    ACC = sql("SELECT id FROM accounts WHERE email_norm='parent@example.com'")[0]["id"]

    print("\n=== the sign-in page ===")
    st, h, _, html = request("GET", P + "/")
    hl = {k.lower(): v for k, v in h.items()}
    check("signed out, / is the sign-in page", st == 200 and "Email me a sign-in link" in html, st)
    check("the form posts to the portal", f'action="{P}/auth/email"' in html)
    check("the email field is labelled, required and autocompletes",
          'for="email"' in html and 'autocomplete="email"' in html and 'aria-required="true"' in html)
    check("Turnstile is on the form with the local test key", 'class="cf-turnstile' in html and "1x00000000000000000000AA" in html)
    csp = hl.get("content-security-policy", "")
    check("only this page may load Turnstile: one script origin and its frame, nothing else",
          "script-src https://challenges.cloudflare.com;" in csp and "frame-src https://challenges.cloudflare.com;" in csp
          and "unsafe-inline" not in csp.split("style-src")[0], csp)
    check("the pilot text says the portal is invitation-only" if not SIGNUP_OPEN else "the signup text invites new families",
          ("invited families" in html) != SIGNUP_OPEN)

    print("\n=== asking for a link ===")
    captured.clear()
    st, h, sc, known_html = ask_link("  Parent@Example.com ")
    check("a known address gets 'check your email'", st == 200 and "Check your email" in known_html, st)
    bind_line = cookie_line(sc, "__Host-tns_bind")
    check("a browser-binding cookie is set: __Host-, HttpOnly, Secure, Lax, 15 minutes",
          all(a in bind_line for a in ("Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=900"))
          and "Domain" not in bind_line, bind_line)
    BIND = cookie_value(sc, "__Host-tns_bind")
    settle(1)
    check("exactly one email went out", len(captured) == 1, len(captured))
    mail = captured[0] if captured else {}
    TOKEN = token_from(mail)
    check("to the account's address", mail.get("to") == ["Parent@Example.com"], mail.get("to"))
    check("carrying a 43-character token in the URL FRAGMENT", TOKEN is not None, (mail.get("text") or "")[:300])
    check("never in a query string", "?t=" not in mail.get("text", "") + mail.get("html", ""))
    check("the email says it expires and works once",
          "15 minutes" in mail.get("text", "") and "once" in mail.get("text", "").lower())
    rows = sql("SELECT * FROM auth_login_tokens")
    check("the database holds the token only as a hash", TOKEN and rows and TOKEN not in json.dumps(rows), json.dumps(rows)[:200])

    captured.clear()
    st, _, sc2, unknown_html = ask_link("nobody-here@example.com", ip="10.40.0.2")
    st3, _, _, disabled_html = ask_link("disabled@example.com", ip="10.40.0.3")
    settle(0)
    if not SIGNUP_OPEN:
        check("an unknown address gets the very same page", unknown_html == known_html and st == 200)
        check("a disabled account gets the very same page", disabled_html == known_html and st3 == 200)
        check("and neither is sent anything", len(captured) == 0, [m.get("to") for m in captured])
    check("an unknown address still gets a binding cookie (no tell in the headers)",
          cookie_value(sc2, "__Host-tns_bind") is not None)

    captured.clear()
    st, _, sc3, _ = ask_link("parent@example.com", cookies={"__Host-tns_bind": BIND})
    check("asking again from the same browser keeps its binding", cookie_value(sc3, "__Host-tns_bind") == BIND)
    settle(1)
    SECOND_TOKEN = token_from(captured[0]) if captured else None

    print("\n=== refusals on the request ===")
    st, _, _, html = post(P + "/auth/email", {"email": "not-an-email", "cf-turnstile-response": "d"})
    check("a malformed address is a 400 with the problem listed and the field marked",
          st == 400 and 'class="errors" role="alert"' in html and 'href="#email"' in html and 'aria-invalid="true"' in html, st)
    check("and what they typed is kept", 'value="not-an-email"' in html)
    captured.clear()
    st, _, _, html = post(P + "/auth/email", {"email": "parent@example.com", "cf-turnstile-response": "d", "company": "Acme"},
                          ip="10.40.0.4")
    settle(0)
    check("a filled honeypot looks like success and sends nothing", st == 200 and "Check your email" in html and len(captured) == 0)
    for label, hdrs in (("Sec-Fetch-Site: cross-site", {"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}),
                        ("Sec-Fetch-Site: same-site", {"Sec-Fetch-Site": "same-site", "Origin": "https://tnsaints.com"}),
                        ("a foreign Origin", {"Origin": "https://evil.example"}),
                        ("no Origin at all", {})):
        st, _, _, _ = request("POST", P + "/auth/email", {"email": "parent@example.com", "cf-turnstile-response": "d"},
                              headers=hdrs, ip="10.40.0.5")
        check(f"a cross-site post ({label}) is refused", st == 403, st)
    st, _, _, _ = request("POST", P + "/auth/email", {"email": "parent@example.com"}, headers=SAME_ORIGIN,
                          ip="10.40.0.5", content_type="application/json")
    check("a non-form body is refused", st in (400, 415), st)

    print("\n=== the landing page is inert ===")
    st, h, sc, html = request("GET", P + "/auth/email/verify")
    hl = {k.lower(): v for k, v in h.items()}
    check("it loads", st == 200 and "Finish signing in" in html, st)
    check("it signs nobody in by being opened", not cookie_value(sc, "__Host-tns_session"))
    check("its script never submits the form by itself", ".submit(" not in html and "requestSubmit" not in html)
    check("its script is allowed by hash, not 'unsafe-inline'",
          re.search(r"script-src 'sha256-[A-Za-z0-9+/=]+';", hl.get("content-security-policy", "")) is not None,
          hl.get("content-security-policy"))
    check("it tells a no-JavaScript browser what to do", "<noscript>" in html)

    print("\n=== signing in ===")
    st, h, sc, _ = post(P + "/auth/email/verify", {"t": SECOND_TOKEN or ""}, cookies={"__Host-tns_bind": BIND})
    session_line = cookie_line(sc, "__Host-tns_session")
    SESSION = cookie_value(sc, "__Host-tns_session")
    check("the same browser is signed in straight away (303 back to the portal)",
          st == 303 and h.get("Location") == P + "/" and SESSION, f"{st} {h.get('Location')}")
    check("the session cookie is __Host-, HttpOnly, Secure, Lax, 30 days, no Domain",
          all(a in session_line for a in ("Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"))
          and "Domain" not in session_line, session_line)
    check("the binding cookie is cleared", "Max-Age=0" in cookie_line(sc, "__Host-tns_bind"))
    srows = sql(f"SELECT * FROM sessions WHERE account_id={ACC}")
    check("the database holds the session only as a hash", SESSION and srows and SESSION not in json.dumps(srows), json.dumps(srows)[:200])
    check("with a coarse device label, not a User-Agent", srows and srows[0].get("device_label", "").count(" on ") == 1,
          srows[0].get("device_label") if srows else None)
    st, _, _, html = request("GET", P + "/", cookies={"__Host-tns_session": SESSION})
    check("signed in, the front door is the family area (setup, with Sign out)",
          st == 200 and "Set up your family" in html and "Sign out" in html, st)
    st, _, _, html = request("GET", P + "/account", cookies={"__Host-tns_session": SESSION})
    check("the account page shows who is signed in", st == 200 and "parent@example.com" in html.lower(), st)
    audit = sql("SELECT actor, action, detail FROM audit_log WHERE action='portal.signin' ORDER BY id DESC LIMIT 1")
    check("the sign-in is audited by account id, never by address",
          audit and audit[0]["actor"] == f"account:{ACC}" and "@" not in json.dumps(audit), audit)

    st, _, sc, html = post(P + "/auth/email/verify", {"t": SECOND_TOKEN or ""}, cookies={"__Host-tns_bind": BIND})
    check("the same link cannot be used twice", st == 400 and "expired" in html and not cookie_value(sc, "__Host-tns_session"), st)
    st, _, sc, html = post(P + "/auth/email/verify", {"t": "x" * 43})
    check("an invented token is refused the same way", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)
    st, _, sc, _ = post(P + "/auth/email/verify", {"t": TOKEN or ""}, cookies={"__Host-tns_bind": BIND})
    check("the first link from earlier also still works once (links are independent)",
          st == 303 and cookie_value(sc, "__Host-tns_session"), st)

    print("\n=== another browser must confirm ===")
    captured.clear()
    ask_link("parent@example.com", ip="10.40.0.6")
    settle(1)
    OTHER = token_from(captured[0]) if captured else ""
    st, _, sc, html = post(P + "/auth/email/verify", {"t": OTHER})
    check("opened elsewhere, the link asks 'is this you?' instead of signing in",
          st == 200 and "Is this you?" in html and not cookie_value(sc, "__Host-tns_session"), st)
    check("naming the account, partly masked", "p•••@example.com" in html and "parent@example.com" not in html)
    row = sql("SELECT consumed_at FROM auth_login_tokens ORDER BY created_at DESC LIMIT 1")
    check("asking does not use up the link", row and row[0]["consumed_at"] is None, row)
    st, _, sc, _ = post(P + "/auth/email/verify", {"t": OTHER, "confirm": "1"})
    CONFIRMED = cookie_value(sc, "__Host-tns_session")
    check("confirming signs in", st == 303 and CONFIRMED, st)

    print("\n=== expiry ===")
    captured.clear()
    ask_link("other@example.com", ip="10.40.0.7")
    settle(1)
    OLD = token_from(captured[0]) if captured else ""
    sql("UPDATE auth_login_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE email_norm='other@example.com'")
    st, _, sc, _ = post(P + "/auth/email/verify", {"t": OLD, "confirm": "1"})
    check("an expired link is refused", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)

    print("\n=== limits ===")
    captured.clear()
    sql("DELETE FROM rate_limits")
    for i in range(4):
        ask_link("other@example.com", ip=f"10.41.0.{i + 1}")
    settle(3)
    check("three links per address per 15 minutes, then silence (same page, nothing sent)",
          len(captured) == 3, len(captured))
    sql("DELETE FROM rate_limits")
    statuses = [ask_link(f"flood{i}@example.com", ip="10.42.0.1")[0] for i in range(21)]
    check("twenty requests per connection per 15 minutes, then 'please wait'",
          statuses[:20].count(200) == 20 and statuses[20] == 429, statuses[-3:])

    print("\n=== sign-out and session lifetime ===")
    st, h, sc, _ = post(P + "/auth/signout", {}, cookies={"__Host-tns_session": SESSION})
    check("sign-out redirects and clears the cookie", st == 303 and "Max-Age=0" in cookie_line(sc, "__Host-tns_session"), st)
    st, _, _, html = request("GET", P + "/", cookies={"__Host-tns_session": SESSION})
    check("the old cookie no longer signs in", "Email me a sign-in link" in html)
    st, _, _, _ = request("POST", P + "/auth/signout", {}, cookies={"__Host-tns_session": SESSION},
                          headers={"Sec-Fetch-Site": "cross-site"})
    check("a cross-site sign-out is refused too", st == 403, st)

    st, _, _, html = request("GET", P + "/", cookies={"__Host-tns_session": CONFIRMED})
    check("other sessions for the account are untouched by one sign-out", "Sign out" in html)
    sql(f"UPDATE sessions SET idle_expires_at='2000-01-01T00:00:00.000Z' WHERE account_id={ACC}")
    st, _, _, html = request("GET", P + "/", cookies={"__Host-tns_session": CONFIRMED})
    check("an idle-expired session is signed out", "Email me a sign-in link" in html)

    sql(f"DELETE FROM sessions WHERE account_id={ACC}")
    values = ", ".join(
        f"('seeded-{i:02d}', {ACC}, 'email', {NOW}, '2026-01-{i + 1:02d}T00:00:00.000Z', {NOW}, "
        f"'2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')" for i in range(10))
    sql("INSERT INTO sessions (id_hash, account_id, auth_method, auth_at, created_at, last_seen_at, "
        f"idle_expires_at, absolute_expires_at) VALUES {values}")
    sql("DELETE FROM rate_limits")
    captured.clear()
    ask_link("parent@example.com", cookies={"__Host-tns_bind": BIND}, ip="10.43.0.1")
    settle(1)
    post(P + "/auth/email/verify", {"t": token_from(captured[0]) if captured else ""}, cookies={"__Host-tns_bind": BIND})
    live = sql(f"SELECT id_hash FROM sessions WHERE account_id={ACC} AND revoked_at IS NULL ORDER BY created_at")
    check("an account keeps at most ten live sessions, dropping the oldest",
          len(live) == 10 and all(r["id_hash"] != "seeded-00" for r in live), [r["id_hash"] for r in live][:3])

    if SIGNUP_OPEN:
        print("\n=== self-signup (PORTAL_SIGNUP_ENABLED=true) ===")
        captured.clear()
        sql("DELETE FROM rate_limits")
        ask_link("brand-new@example.com", ip="10.44.0.1")
        settle(1)
        check("a new address is sent a link", len(captured) == 1)
        st, _, sc, _ = post(P + "/auth/email/verify", {"t": token_from(captured[0]) if captured else "", "confirm": "1"})
        acct = sql("SELECT id, status FROM accounts WHERE email_norm='brand-new@example.com'")
        check("following it creates the account and signs in",
              st == 303 and cookie_value(sc, "__Host-tns_session") and acct and acct[0]["status"] == "active", acct)
    else:
        print("\n=== invite-only pilot (PORTAL_SIGNUP_ENABLED unset) ===")
        acct = sql("SELECT id FROM accounts WHERE email_norm='nobody-here@example.com'")
        check("no account was created for the unknown address", acct == [], acct)

finally:
    server.shutdown()

print("\n=== pure rules (imported directly) ===")
UNIT = r"""
import { mayReceiveLink, maskEmail, portalOrigin } from './src/auth/magic.js';
import { keyedHash, randomToken, safeEqual, authConfigured } from './src/lib/crypto.js';
import { hostCookie, deviceLabel } from './src/auth/session.js';
const env = { AUTH_PEPPER: 'p'.repeat(40) };
const a = await keyedHash(env, 'session', 'same-value');
const b = await keyedHash(env, 'login', 'same-value');
let missing = null;
try { await keyedHash({ AUTH_PEPPER: 'short' }, 'session', 'x'); } catch (e) { missing = e.constructor.name; }
console.log(JSON.stringify({
  eligible: [mayReceiveLink({ status: 'active' }, {}), mayReceiveLink({ status: 'disabled' }, {}),
             mayReceiveLink({ status: 'deleted' }, { PORTAL_SIGNUP_ENABLED: 'true' }),
             mayReceiveLink(null, {}), mayReceiveLink(null, { PORTAL_SIGNUP_ENABLED: 'True' }),
             mayReceiveLink(null, { PORTAL_SIGNUP_ENABLED: 'true' })],
  masks: [maskEmail('jacob@gmail.com'), maskEmail('j@x.org'), maskEmail('garbage')],
  origin: [portalOrigin({ PORTAL_HOSTNAME: 'portal.tnsaints.com' }), portalOrigin({ PORTAL_ORIGIN: 'http://127.0.0.1:8787/' })],
  domainSeparated: a !== b, deterministic: a === await keyedHash(env, 'session', 'same-value'),
  tokenLen: randomToken().length, distinct: randomToken() !== randomToken(),
  safeEqual: [safeEqual('abc', 'abc'), safeEqual('abc', 'abd'), safeEqual('abc', 'ab')],
  configured: [authConfigured({}), authConfigured({ AUTH_PEPPER: 'short' }), authConfigured(env)],
  missing,
  cookie: hostCookie('__Host-x', 'v', 60),
  device: [deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1'),
           deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/120.0 Safari/537.36 Edg/120.0'),
           deviceLabel('')],
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-400:])
if u:
    check("links go to active accounts; to no-one else unless signup is exactly 'true'",
          u["eligible"] == [True, False, False, False, False, True], u["eligible"])
    check("addresses are masked for the confirm page", u["masks"] == ["j•••@gmail.com", "•••@x.org", "•••"], u["masks"])
    check("link origin: production derives it, local overrides it",
          u["origin"] == ["https://portal.tnsaints.com", "http://127.0.0.1:8787"], u["origin"])
    check("hashes are domain-separated by purpose", u["domainSeparated"] and u["deterministic"])
    check("tokens are 43 characters (256 bits) and never repeat", u["tokenLen"] == 43 and u["distinct"])
    check("constant-time compare behaves", u["safeEqual"] == [True, False, False], u["safeEqual"])
    check("a missing or short AUTH_PEPPER is 'not configured', and hashing refuses",
          u["configured"] == [False, False, True] and u["missing"] == "AuthConfigError", (u["configured"], u["missing"]))
    check("host cookies carry every required attribute", u["cookie"] == "__Host-x=v; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
          u["cookie"])
    check("device labels are coarse", u["device"] == ["Safari on iPhone", "Edge on Windows", "Browser on unknown device"],
          u["device"])

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
sys.exit(1 if failed else 0)
