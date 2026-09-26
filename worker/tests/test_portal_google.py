"""Sign in with Google (src/auth/google.js), against a mock provider.

The mock serves /certs (a JWKS with a key generated for this run) and /token
(returns whatever ID token the test queues, after checking the PKCE verifier
against the challenge the Worker sent). The Worker is pointed at it with
GOOGLE_OIDC_BASE, which it honours only for a loopback URL behind the local dev
door. The real verifier runs on every token: nothing about checking is mocked.

Proved here:
  - the redirect to Google carries state, nonce and an S256 PKCE challenge, and
    the database keeps only hashes of them
  - a callback is refused unless its state is live, unused, and returns to the
    browser that started it
  - an ID token is refused on a bad signature, alg none/HS256, wrong issuer,
    wrong audience, wrong azp, wrong nonce, expiry, or an unverified email
  - accounts are found by Google's `sub`, never by the email claim
  - Google may vouch for an address only where it is authoritative (gmail.com,
    or a Workspace `hd` matching the domain); otherwise: email link first
  - while signup is closed, an unknown Google address gets no account
  - a signed-in parent (recently) can connect Google; a Google account already
    tied to another family cannot be connected
"""
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight
from _portal import (BASE, P, WORKER_DIR, Checker, b64url, cookie_line, cookie_value, get, keyed_hash,
                     make_account, mint_session, post, require_portal, session_cookies, sql)

preflight(BASE)
settings = require_portal()
MOCK_PORT = 8798
MOCK = f"http://127.0.0.1:{MOCK_PORT}"
CLIENT_ID = settings.get("GOOGLE_CLIENT_ID", "")
if settings.get("GOOGLE_SIGNIN_ENABLED") != "true" or settings.get("GOOGLE_OIDC_BASE") != MOCK or not CLIENT_ID \
        or not settings.get("GOOGLE_CLIENT_SECRET"):
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs the mock Google provider settings:\n"
             "      GOOGLE_SIGNIN_ENABLED=true\n      GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com\n"
             f"      GOOGLE_CLIENT_SECRET=local-test-secret\n      GOOGLE_OIDC_BASE={MOCK}\n")
SIGNUP_OPEN = settings.get("PORTAL_SIGNUP_ENABLED") == "true"

check = Checker()

# --- keys for this run -------------------------------------------------------
KEYS = json.loads(subprocess.run(["node", "tests/_oidc_sign.mjs", "keys"], capture_output=True,
                                 cwd=WORKER_DIR, check=True).stdout)
KEYFILE = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump(KEYS, KEYFILE)
KEYFILE.close()
OTHER_KEYS = json.loads(subprocess.run(["node", "tests/_oidc_sign.mjs", "keys"], capture_output=True,
                                       cwd=WORKER_DIR, check=True).stdout)
OTHER_KEYFILE = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump(OTHER_KEYS, OTHER_KEYFILE)
OTHER_KEYFILE.close()


def sign(claims, keyfile=None):
    return subprocess.run(["node", "tests/_oidc_sign.mjs", "sign", keyfile or KEYFILE.name],
                          input=json.dumps(claims).encode(), capture_output=True, cwd=WORKER_DIR, check=True
                          ).stdout.decode()


def unsigned(claims, alg):
    header = b64url(json.dumps({"alg": alg, "typ": "JWT", "kid": KEYS["public"]["kid"]}).encode())
    payload = b64url(json.dumps({**claims, "iat": int(time.time()), "exp": int(time.time()) + 3600}).encode())
    if alg == "none":
        return f"{header}.{payload}."
    sig = hmac.new(json.dumps(KEYS["public"]).encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


# --- the mock provider -----------------------------------------------------------
mock = {"next_token": None, "challenge": None, "pkce_ok": None, "token_calls": 0}


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/certs"):
            return self._send(200, {"keys": [KEYS["public"]]})
        return self._send(404, {})

    def do_POST(self):
        form = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
        mock["token_calls"] += 1
        verifier = (form.get("code_verifier") or [""])[0]
        mock["pkce_ok"] = b64url(hashlib.sha256(verifier.encode()).digest()) == mock["challenge"]
        if not mock["pkce_ok"] or (form.get("client_secret") or [""])[0] != settings["GOOGLE_CLIENT_SECRET"]:
            return self._send(400, {"error": "invalid_grant"})
        return self._send(200, {"access_token": "discarded", "token_type": "Bearer", "expires_in": 3600,
                                "id_token": mock["next_token"]})

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"\n  mock Google provider listening on {MOCK}")


def start(cookies=None, mode="signin"):
    """POST /auth/google/start -> (status, authorize query dict, flow cookie, Location)."""
    st, h, sc, _ = post(P + "/auth/google/start", {"mode": mode}, cookies=cookies)
    loc = h.get("Location", "")
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).items()}
    mock["challenge"] = q.get("code_challenge")
    return st, q, cookie_value(sc, "__Host-tns_oidc"), loc, sc


def claims_for(q, **over):
    base = {"iss": MOCK, "aud": CLIENT_ID, "azp": CLIENT_ID, "sub": "google-sub-1",
            "email": "family@gmail.com", "email_verified": True, "nonce": q.get("nonce"), "name": "Family Parent"}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


def attempt(token_fn, cookies=None, mode="signin", **over):
    """One full sign-in: start, queue a token, call back. Returns (status, Set-Cookies, body, Location)."""
    st, q, flow, _, _ = start(cookies, mode)
    mock["next_token"] = token_fn(claims_for(q, **over))
    jar = {"__Host-tns_oidc": flow, **(cookies or {})}
    st, h, sc, body = get(P + f"/auth/google/callback?state={q['state']}&code=auth-code", cookies=jar)
    return st, sc, body, h.get("Location", "")


try:
    for t in ["sessions", "auth_oidc_flows", "account_identities", "household_members", "accounts"]:
        sql(f"DELETE FROM {t}")

    print("\n=== the button and the redirect ===")
    st, _, _, html = get(P + "/")
    check("the sign-in page offers Google", "Continue with Google" in html and f'action="{P}/auth/google/start"' in html)
    st, q, flow, loc, sc = start()
    check("start is a 303 to the provider's authorize endpoint", st == 303 and loc.startswith(MOCK + "/authorize?"), loc[:80])
    check("with our client id, the code flow, and only openid email profile",
          q.get("client_id") == CLIENT_ID and q.get("response_type") == "code" and q.get("scope") == "openid email profile", q)
    check("returning to the portal's callback", q.get("redirect_uri") == f"{BASE}{P}/auth/google/callback", q.get("redirect_uri"))
    check("state and nonce are 43-character random values",
          len(q.get("state", "")) == 43 and len(q.get("nonce", "")) == 43 and q["state"] != q["nonce"])
    check("PKCE S256 challenge present", q.get("code_challenge_method") == "S256" and len(q.get("code_challenge", "")) == 43)
    flow_line = cookie_line(sc, "__Host-tns_oidc")
    check("a 10-minute __Host- flow cookie binds the attempt to this browser",
          all(a in flow_line for a in ("Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600")), flow_line)
    rows = sql("SELECT * FROM auth_oidc_flows")
    check("the database holds hashes, not the state, nonce or cookie",
          rows and not any(v in json.dumps(rows) for v in (q["state"], q["nonce"], flow)), json.dumps(rows)[:200])
    st, _, _, _ = get(P + "/auth/google/start")
    check("start is POST-only", st == 404, st)
    st, _, _, _ = post(P + "/auth/google/start", {"mode": "signin"}, headers={"Sec-Fetch-Site": "cross-site"})
    check("a cross-site start is refused", st == 403, st)

    print("\n=== who gets in ===")
    make_account("Family@Gmail.com")
    fam = sql("SELECT id FROM accounts WHERE email_norm='family@gmail.com'")[0]["id"]
    st, sc, body, loc = attempt(sign)
    SID = cookie_value(sc, "__Host-tns_session")
    check("a gmail address with an existing account signs straight in", st == 303 and SID and loc == P + "/", (st, body[:120]))
    check("PKCE was verified by the provider", mock["pkce_ok"] is True)
    check("the flow cookie is cleared", "Max-Age=0" in cookie_line(sc, "__Host-tns_oidc"))
    ident = sql(f"SELECT provider, subject FROM account_identities WHERE account_id={fam}")
    check("Google's `sub` is now linked to that account", {"provider": "google", "subject": "google-sub-1"} in ident, ident)
    audit = sql("SELECT actor, detail FROM audit_log WHERE action='portal.signin' ORDER BY id DESC LIMIT 1")
    check("audited by account id, never address", audit and audit[0]["actor"] == f"account:{fam}" and "@" not in json.dumps(audit))

    make_account("someone.else@gmail.com")
    st, sc, body, _ = attempt(sign, email="someone.else@gmail.com")
    new_sid = cookie_value(sc, "__Host-tns_session") or ""
    owner = sql(f"SELECT account_id FROM sessions WHERE id_hash='{keyed_hash('session', new_sid)}'")
    check("a linked `sub` wins over the email claim: the same Google account stays with its family",
          st == 303 and owner and owner[0]["account_id"] == fam, (st, owner, body[:120]))
    other = sql("SELECT id FROM accounts WHERE email_norm='someone.else@gmail.com'")[0]["id"]
    check("and nothing was linked to the other address's account",
          sql(f"SELECT 1 FROM account_identities WHERE account_id={other}") == [])

    make_account("coach@school.org")
    st, sc, body, _ = attempt(sign, sub="ws-sub-1", email="coach@school.org", hd="school.org")
    check("a Workspace account whose hd matches its domain signs in", st == 303 and cookie_value(sc, "__Host-tns_session"),
          (st, body[:120]))

    make_account("parent@yahoo.com")
    st, sc, body, _ = attempt(sign, sub="yahoo-sub", email="parent@yahoo.com", hd=None)
    check("a Google account on a non-Google address must use an email link first",
          st == 400 and "email link the first time" in body and not cookie_value(sc, "__Host-tns_session"), (st, body[:120]))
    check("and nothing was linked", sql("SELECT 1 FROM account_identities WHERE subject='yahoo-sub'") == [])
    st, sc, body, _ = attempt(sign, sub="hd-mismatch", email="parent@school.org", hd="other.org")
    check("an hd that does not match the address is not authoritative", st == 400 and "email link" in body, st)

    st, sc, body, _ = attempt(sign, sub="new-sub", email="new.family@gmail.com")
    if SIGNUP_OPEN:
        check("with signup open, a new gmail address gets an account", st == 303 and cookie_value(sc, "__Host-tns_session"))
    else:
        check("with signup closed, a new gmail address gets no account",
              st == 400 and "no portal account" in body and not cookie_value(sc, "__Host-tns_session"), (st, body[:120]))
        check("and none was created", sql("SELECT 1 FROM accounts WHERE email_norm='new.family@gmail.com'") == [])

    make_account("off@gmail.com", status="disabled")
    st, sc, body, _ = attempt(sign, sub="off-sub", email="off@gmail.com")
    check("a disabled account cannot sign in with Google", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)

    print("\n=== every token check ===")
    later = int(time.time()) - 7200
    cases = [
        ("a token signed by an unknown key", lambda c: sign(c, OTHER_KEYFILE.name), {}),
        ("alg: none", lambda c: unsigned(c, "none"), {}),
        ("HS256 keyed with the public key (algorithm confusion)", lambda c: unsigned(c, "HS256"), {}),
        ("the wrong issuer", sign, {"iss": "https://evil.example"}),
        ("the wrong audience", sign, {"aud": "someone-elses-client"}),
        ("a different authorized party (azp)", sign, {"azp": "someone-elses-client"}),
        ("the wrong nonce", sign, {"nonce": "x" * 43}),
        ("no nonce", sign, {"nonce": None}),
        ("an expired token", sign, {"exp": later, "iat": later - 3600}),
        ("an unverified email", sign, {"email_verified": False}),
    ]
    for label, fn, over in cases:
        st, sc, body, _ = attempt(fn, **over)
        check(f"refused: {label}", st == 400 and not cookie_value(sc, "__Host-tns_session"), (st, body[:100]))

    print("\n=== the callback itself ===")
    st, q, flow, _, _ = start()
    mock["next_token"] = sign(claims_for(q))
    calls = mock["token_calls"]
    st, _, sc, body = get(P + f"/auth/google/callback?state={q['state']}&code=c")
    check("no flow cookie (another browser, or login CSRF): refused", st == 400 and "expired" in body, st)
    st, _, sc, body = get(P + f"/auth/google/callback?state={q['state']}&code=c",
                          cookies={"__Host-tns_oidc": b64url(os.urandom(32))})
    check("someone else's flow cookie: refused", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)
    st, _, sc, _ = get(P + f"/auth/google/callback?state={q['state']}&code=c", cookies={"__Host-tns_oidc": flow})
    check("the right browser still completes it", st == 303 and cookie_value(sc, "__Host-tns_session"), st)
    st, _, sc, body = get(P + f"/auth/google/callback?state={q['state']}&code=c", cookies={"__Host-tns_oidc": flow})
    check("a state cannot be used twice", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)
    check("and a refused callback never reaches the token endpoint", mock["token_calls"] == calls + 1, mock["token_calls"])
    st, q, flow, _, _ = start()
    sql("UPDATE auth_oidc_flows SET expires_at='2000-01-01T00:00:00.000Z'")
    st, _, sc, _ = get(P + f"/auth/google/callback?state={q['state']}&code=c", cookies={"__Host-tns_oidc": flow})
    check("an expired flow is refused", st == 400 and not cookie_value(sc, "__Host-tns_session"), st)
    st, _, _, body = get(P + "/auth/google/callback?error=access_denied")
    check("pressing Cancel at Google says so plainly", st == 400 and "cancelled" in body, st)

    print("\n=== connecting Google to a signed-in account ===")
    yahoo = sql("SELECT id FROM accounts WHERE email_norm='parent@yahoo.com'")[0]["id"]
    stale = mint_session(yahoo, recent=False)
    st, _, sc, body = post(P + "/auth/google/start", {"mode": "link"}, cookies=session_cookies(stale))
    check("connecting needs a recent sign-in", st in (400, 403) and "sign in again" in body.lower(), (st, body[:120]))
    fresh = mint_session(yahoo, recent=True)
    st, sc, body, loc = attempt(sign, cookies=session_cookies(fresh), mode="link", sub="yahoo-sub",
                                email="parent@yahoo.com", hd=None)
    check("a recently signed-in parent can connect their Google account", st == 303 and loc == P + "/", (st, body[:120]))
    check("it is linked to them", sql(f"SELECT 1 FROM account_identities WHERE account_id={yahoo} AND subject='yahoo-sub'") != [])
    st, sc, body, _ = attempt(sign, sub="yahoo-sub", email="parent@yahoo.com", hd=None)
    check("and from then on Google signs them straight in", st == 303 and cookie_value(sc, "__Host-tns_session"), st)
    st, sc, body, _ = attempt(sign, cookies=session_cookies(fresh), mode="link", sub="google-sub-1")
    check("a Google account already tied to another family cannot be connected", st == 400 and "different family" in body, st)

finally:
    server.shutdown()
    for f in (KEYFILE.name, OTHER_KEYFILE.name):
        try:
            os.unlink(f)
        except OSError:
            pass

print("\n=== pure rules (imported directly) ===")
UNIT = r"""
import { googleIsAuthoritative, providerFor } from './src/auth/google.js';
const A = (c) => googleIsAuthoritative({ email_verified: true, ...c });
console.log(JSON.stringify({
  auth: [A({ email: 'a@gmail.com' }), A({ email: 'A@GoogleMail.com' }), A({ email: 'a@school.org', hd: 'school.org' }),
         A({ email: 'a@school.org', hd: 'SCHOOL.org' }), A({ email: 'a@school.org' }), A({ email: 'a@school.org', hd: 'other.org' }),
         A({ email: 'a@yahoo.com' }), googleIsAuthoritative({ email: 'a@gmail.com', email_verified: false }),
         A({ email: 'not-an-address' })],
  prodIgnoresOverride: providerFor({ GOOGLE_OIDC_BASE: 'http://127.0.0.1:8798' }, { isDev: false }).token,
  devRemoteRefused: providerFor({ GOOGLE_OIDC_BASE: 'https://evil.example' }, { isDev: true }).token,
  devLoopback: providerFor({ GOOGLE_OIDC_BASE: 'http://127.0.0.1:8798' }, { isDev: true }).token,
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-400:])
if u:
    check("Google is authoritative only for gmail and matching Workspace domains, and only when verified",
          u["auth"] == [True, True, True, True, False, False, False, False, False], u["auth"])
    check("in production the mock override is ignored", u["prodIgnoresOverride"] == "https://oauth2.googleapis.com/token")
    check("locally, a non-loopback override is ignored too", u["devRemoteRefused"] == "https://oauth2.googleapis.com/token")
    check("locally, a loopback override is honoured", u["devLoopback"] == "http://127.0.0.1:8798/token")

check.finish()
