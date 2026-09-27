"""Paying for an offered place (src/portal/pay.js, src/payments/*), against a mock PayPal.

The mock serves OAuth, subscriptions, sales and a signing certificate on
127.0.0.1:8797. Webhooks are signed exactly as PayPal signs them
(<transmission id>|<time>|<webhook id>|<CRC-32 of the body>, SHA256withRSA)
with a key and certificate generated for this run by openssl, and the Worker's
real verifier checks them. Nothing about checking is mocked.

Proved here: the pay page exists only for a live offer in your own family;
a subscription activates a place only if PayPal confirms the plan, the ref and
the status; the webhook refuses anything not signed by a certificate from an
allowed host; state always follows what PayPal says, not what an event claims;
a family who closed the tab is still enrolled; payments land once, in cents.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import (BASE, P, WORKER_DIR, Checker, get, make_account, mint_session, post, require_portal,
                     session_cookies, sql)

preflight(BASE)
settings = require_portal()
MOCK = "http://127.0.0.1:8797"
if settings.get("PAYPAL_API_BASE") != MOCK or settings.get("PAYPAL_WEBHOOK_ENABLED") != "true":
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs the mock PayPal settings (see .dev.vars.example):\n"
             f"      PAYPAL_API_BASE={MOCK}\n      PAYPAL_CLIENT_ID_SANDBOX=mock-client-id\n"
             "      PAYPAL_CLIENT_SECRET_SANDBOX=mock-client-secret\n      PAYPAL_WEBHOOK_ID_SANDBOX=WH-MOCK-0001\n"
             "      PAYPAL_WEBHOOK_ENABLED=true\n")
WEBHOOK_ID = settings["PAYPAL_WEBHOOK_ID_SANDBOX"]
CLIENT = (settings["PAYPAL_CLIENT_ID_SANDBOX"], settings["PAYPAL_CLIENT_SECRET_SANDBOX"])
check = Checker()
ME = staff_email()
PLAN = "P-SANDBOXPLAN000001"

# --- a signing key and certificate for this run ----------------------------------
TMP = tempfile.mkdtemp(prefix="tns-pp-")
KEY, CERT = os.path.join(TMP, "key.pem"), os.path.join(TMP, "cert.pem")
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CERT,
                "-days", "2", "-subj", "/CN=mock-paypal-webhooks"], check=True, capture_output=True)
CERT_PEM = open(CERT, encoding="ascii").read()
CERT_PATH = f"/v1/notifications/certs/CERT-{uuid.uuid4().hex[:12]}"  # fresh per run: the Worker caches by URL

state = {"subs": {}, "sales": {}, "cert_fetches": 0}


class PayPal(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, obj=None, text=None, ctype="application/json"):
        body = (text if text is not None else json.dumps(obj or {})).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/v1/oauth2/token":
            expected = "Basic " + base64.b64encode(f"{CLIENT[0]}:{CLIENT[1]}".encode()).decode()
            if self.headers.get("Authorization") != expected:
                return self._send(401, {"error": "invalid_client"})
            return self._send(200, {"access_token": "mock-access-token", "expires_in": 32400})
        return self._send(404)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer mock-access-token" and not self.path.startswith("/v1/notifications/certs/"):
            return self._send(401)
        m = re.match(r"^/v1/billing/subscriptions/([A-Z0-9-]+)$", self.path)
        if m:
            sub = state["subs"].get(m.group(1))
            return self._send(200, sub) if sub else self._send(404, {"name": "RESOURCE_NOT_FOUND"})
        m = re.match(r"^/v1/payments/sale/([A-Z0-9]+)$", self.path)
        if m:
            sale = state["sales"].get(m.group(1))
            return self._send(200, sale) if sale else self._send(404)
        if self.path == CERT_PATH:
            state["cert_fetches"] += 1
            return self._send(200, text=CERT_PEM, ctype="application/x-pem-file")
        return self._send(404)

    def log_message(self, *args):
        pass


def subscription(sid, ref, status="ACTIVE", plan=PLAN):
    state["subs"][sid] = {"id": sid, "plan_id": plan, "status": status, "custom_id": ref,
                          "billing_info": {"next_billing_time": "2026-11-06T14:00:00Z"}}


def webhook(event, *, sign=True, cert_url=None, algo="SHA256withRSA", tamper=False, webhook_id=None):
    body = json.dumps(event).encode()
    tid, ttime = str(uuid.uuid4()), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    message = f"{tid}|{ttime}|{webhook_id or WEBHOOK_ID}|{zlib.crc32(body) & 0xffffffff}".encode()
    sig = base64.b64encode(subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY], input=message,
                                          capture_output=True, check=True).stdout).decode()
    if tamper:
        tampered = body.replace(b"ACTIVATED", b"ACTIVATEX")
        assert tampered != body, "the tamper must change the bytes, or this check proves nothing"
        body = tampered
    req = urllib.request.Request(BASE + "/api/paypal/webhook", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if sign:
        req.add_header("PAYPAL-TRANSMISSION-ID", tid)
        req.add_header("PAYPAL-TRANSMISSION-TIME", ttime)
        req.add_header("PAYPAL-TRANSMISSION-SIG", sig)
        req.add_header("PAYPAL-CERT-URL", cert_url or MOCK + CERT_PATH)
        req.add_header("PAYPAL-AUTH-ALGO", algo)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def event(etype, resource, eid=None):
    return {"id": eid or f"WH-{uuid.uuid4().hex[:20].upper()}", "event_type": etype, "resource": resource}


def approve(s, ref, sid, headers=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else json.dumps({"subscription_id": sid}).encode()
    req = urllib.request.Request(BASE + P + f"/pay/{ref}/approved", data=data, method="POST")
    req.add_header("Content-Type", ctype)
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in s.items()))
    for k, v in (headers or {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8787"}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        body, status = e.read().decode(), e.code
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, body


def status_of(eid):
    return sql(f"SELECT status FROM enrollments WHERE id={eid}")[0]["status"]


def admin_offer(eid, gid):
    data = urllib.parse.urlencode({"group_id": str(gid)}).encode()
    req = urllib.request.Request(BASE + f"/__admin/enrollments/{eid}/offer", data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Sec-Fetch-Site", "same-origin")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        urllib.request.build_opener(NoRedirect).open(req)
    except urllib.error.HTTPError:
        pass


def family(email, name):
    acc = make_account(email)
    s = session_cookies(mint_session(acc))
    post(P + "/family/setup", {"guardian_name": f"{name} Parent", "phone": "(615) 555-0100", "relationship": "Mother"}, cookies=s)
    post(P + "/children", {"child_name": f"{name} Kid", "date_of_birth": "2016-04-04", "grade": "4",
                           "school": "Test School", "shirt_size": "YM"}, cookies=s)
    kid = sql(f"SELECT id FROM players WHERE display_name='{name} Kid'")[0]["id"]
    post(P + f"/children/{kid}/medical", {"medical_status": "none_declared"}, cookies=s)
    post(P + "/contacts", {"ec1_name": "EC", "ec1_phone": "(615) 555-0199"}, cookies=s)
    post(P + f"/children/{kid}/apply/academy", {"waiver_version": "pay-test-v1", "agree_risk": "on", "agree_medical": "on",
                                                "agree_esign": "on", "photo_release": "no", "signature": f"{name} Parent",
                                                "relationship": "Mother"}, cookies=s)
    e = sql(f"SELECT id, ref FROM enrollments WHERE player_id={kid}")[0]
    return s, kid, e["id"], e["ref"]


server = ThreadingHTTPServer(("127.0.0.1", 8797), PayPal)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    for t in ["payments", "paypal_events", "billing_subscriptions", "enrollments", "consent_records", "program_groups",
              "player_medical", "household_emergency_contacts", "household_invites", "household_members", "sessions",
              "account_identities", "households", "accounts"]:
        sql(f"DELETE FROM {t}")
    sql("DELETE FROM players WHERE household_id IS NOT NULL")
    sql("UPDATE programs SET status='draft', waiver_version_id=NULL WHERE id='academy'")
    sql("DELETE FROM waiver_versions")
    body = "TEST WAIVER. Basketball involves risk."
    sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
        f"('pay-test-v1', 'Test entity', 'Test waiver', '{body}', '{hashlib.sha256(body.encode()).hexdigest()}', datetime('now'), datetime('now'))")
    sql(f"UPDATE programs SET status='open', price_cents=15000, setup_fee_cents=4000, waiver_version_id='pay-test-v1', "
        f"paypal_plan_id_sandbox='{PLAN}' WHERE id='academy'")
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, location, starts_on, capacity, created_at, updated_at) "
        "VALUES ('academy', 'Tuesday group', 'Tuesdays 6:00-7:30 PM', 'Test Gym', '2099-01-06', 5, datetime('now'), datetime('now'))")
    GID = sql("SELECT id FROM program_groups")[0]["id"]
    sql("DELETE FROM staff")
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    SA, KA, EA, RA = family("alpha@example.com", "Alpha")
    SB, KB, EB, RB = family("bravo@example.com", "Bravo")
    SC, KC, EC, RC = family("charlie@example.com", "Charlie")

    print("\n=== the pay page ===")
    st, _, _, html = get(P + f"/pay/{RA}", cookies=SA)
    check("before an offer there is nothing to pay for", st == 410 and "has ended" in html, st)
    for eid in (EA, EB, EC):
        admin_offer(eid, GID)
    st, h, _, html = get(P + f"/pay/{RA}", cookies=SA)
    hl = {k.lower(): v for k, v in h.items()}
    check("with a live offer, the pay page opens", st == 200 and "Accept the place" in html and "Alpha Kid" in html, st)
    check("it shows group, schedule, first session and cost in words",
          all(s in html for s in ("Tuesday group", "Tuesdays 6:00-7:30 PM", "First session", "$150 a month")))
    check("the button carries the sandbox plan and the ref, nothing about the child",
          f'data-plan="{PLAN}"' in html and f'data-ref="{RA}"' in html)
    check("monthly billing starts at the first session (start_time sent to PayPal)", 'data-start="2099-01-06T14:00:00Z"' in html)
    nonces = set(re.findall(r'<script nonce="([A-Za-z0-9_-]+)"', html))
    csp = hl.get("content-security-policy", "")
    check("both scripts carry one per-response nonce that the CSP names",
          len(nonces) == 1 and f"'nonce-{next(iter(nonces))}'" in csp if nonces else False, csp)
    check("the CSP allows PayPal's hosts and nothing else for script and frames",
          "https://www.paypal.com" in csp and "frame-src https://*.paypal.com;" in csp and "unsafe-inline" not in csp.split("style-src")[0])
    check("the SDK loads with the sandbox client id", "client-id=mock-client-id" in html)
    check("PayPal's window may talk back (COOP same-origin-allow-popups)",
          hl.get("cross-origin-opener-policy") == "same-origin-allow-popups")
    check("it says plainly this is test mode", "Test mode" in html)
    _, _, _, html2 = get(P + f"/pay/{RA}", cookies=SA)
    check("a new nonce on every response", set(re.findall(r'<script nonce="([A-Za-z0-9_-]+)"', html2)) != nonces)
    st, _, _, _ = get(P + f"/pay/{RA}", cookies=SB)
    check("another family cannot open it", st == 404, st)
    st, _, _, _ = get(P + "/pay/" + "x" * 22, cookies=SA)
    check("an unknown ref is a 404", st == 404, st)

    print("\n=== confirming a payment ===")
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("a subscription PayPal does not know is refused", st == 409 and not r.get("ok") and status_of(EA) == "offered", (st, r))
    subscription("I-ALPHA0000001", RA, plan="P-SOMEOTHERPLAN0001")
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("a subscription to a different plan is refused", st == 400 and status_of(EA) == "offered", (st, r))
    subscription("I-ALPHA0000001", RB)
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("a subscription made out to another place (custom_id) is refused", st == 400 and status_of(EA) == "offered", (st, r))
    subscription("I-ALPHA0000001", RA, status="APPROVAL_PENDING")
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("a subscription not yet approved at PayPal is refused", st == 400 and status_of(EA) == "offered", (st, r))
    subscription("I-ALPHA0000001", RA, status="ACTIVE")
    st, r = approve(SA, RA, "I-ALPHA0000001", ctype="application/x-www-form-urlencoded", raw=b"subscription_id=I-ALPHA0000001")
    check("the confirmation must be JSON from the page itself", st == 415, st)
    st, r = approve(SA, RA, "I-ALPHA0000001", headers={"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"})
    check("a cross-site confirmation is refused", st == 403 and status_of(EA) == "offered", st)
    st, r = approve(SB, RA, "I-ALPHA0000001")
    check("another family cannot confirm it", st == 404 and status_of(EA) == "offered", (st, r))
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("PayPal confirms plan, ref and status: the place is paid", st == 200 and r.get("ok")
          and r.get("redirect") == P + "/?notice=paid" and status_of(EA) == "active", (st, r))
    b = sql("SELECT environment, status, source, enrollment_id, household_id, plan_id FROM billing_subscriptions "
            "WHERE paypal_subscription_id='I-ALPHA0000001'")
    check("the subscription is recorded, linked, sandbox, with no payer details",
          b and b[0]["environment"] == "sandbox" and b[0]["enrollment_id"] == EA and b[0]["source"] == "portal", b)
    st, r = approve(SA, RA, "I-ALPHA0000001")
    check("confirming again is harmless", st == 200 and r.get("ok"), (st, r))
    st, _, _, html = get(P + "/?notice=paid", cookies=SA)
    check("the family page says the place is confirmed", "Welcome to the academy" in html and "Academy: Tuesday group" in html)
    st, _, _, html = get(P + f"/pay/{RA}", cookies=SA)
    check("and the pay page now just says you're all set", "all set" in html)

    print("\n=== the webhook refuses anything not signed by PayPal ===")
    subscription("I-BRAVO00000001", RB)
    ev = event("BILLING.SUBSCRIPTION.ACTIVATED", {"id": "I-BRAVO00000001"})
    st, _ = webhook(ev, sign=False)
    check("no signature headers: refused", st == 400 and sql(f"SELECT 1 FROM paypal_events WHERE event_id='{ev['id']}'") == [], st)
    st, _ = webhook(ev, tamper=True)
    check("a body changed after signing: refused", st == 400 and status_of(EB) == "offered", st)
    st, _ = webhook(ev, webhook_id="WH-SOMEONE-ELSES")
    check("signed for a different webhook id: refused", st == 400, st)
    fetches = state["cert_fetches"]
    st, _ = webhook(ev, cert_url="https://evil.example/v1/notifications/certs/CERT-1")
    check("a certificate from a host that is not PayPal is never even fetched", st == 400 and state["cert_fetches"] == fetches, st)
    st, _ = webhook(ev, algo="SHA1withRSA")
    check("any algorithm but SHA256withRSA: refused", st == 400, st)
    check("none of those changed anything", status_of(EB) == "offered" and sql("SELECT 1 FROM paypal_events") == [])

    print("\n=== a signed webhook: the family who closed the tab ===")
    st, text = webhook(ev)
    check("the signed event is accepted", st == 200 and text == "synced", (st, text))
    check("and Bravo's place is active though the page never confirmed it", status_of(EB) == "active")
    b = sql("SELECT linked_by FROM billing_subscriptions WHERE paypal_subscription_id='I-BRAVO00000001'")
    check("linked by the ref PayPal holds (custom_id)", b and b[0]["linked_by"] == "paypal:custom_id", b)
    st, text = webhook(ev)
    check("the same event again is recognised as a duplicate", st == 200 and text == "duplicate", (st, text))
    rows = sql(f"SELECT event_type, resource_id, outcome FROM paypal_events WHERE event_id='{ev['id']}'")
    check("events are kept as identifiers only", rows and set(rows[0]) == {"event_type", "resource_id", "outcome"}, rows)

    print("\n=== state always comes from PayPal, not from the event ===")
    state["subs"]["I-ALPHA0000001"]["status"] = "SUSPENDED"
    st, _ = webhook(event("BILLING.SUBSCRIPTION.ACTIVATED", {"id": "I-ALPHA0000001", "status": "ACTIVE"}))
    check("an event claiming 'activated' while PayPal says suspended: the place is past due", status_of(EA) == "past_due")
    state["subs"]["I-ALPHA0000001"]["status"] = "ACTIVE"
    webhook(event("BILLING.SUBSCRIPTION.RE-ACTIVATED", {"id": "I-ALPHA0000001"}))
    check("PayPal active again: the place is active again", status_of(EA) == "active")
    state["subs"]["I-ALPHA0000001"]["status"] = "CANCELLED"
    webhook(event("BILLING.SUBSCRIPTION.CANCELLED", {"id": "I-ALPHA0000001"}))
    check("PayPal cancelled: the place ends", status_of(EA) == "cancelled")

    print("\n=== payments ===")
    state["sales"]["SALE0000000001"] = {"id": "SALE0000000001", "state": "completed", "billing_agreement_id": "I-BRAVO00000001",
                                        "amount": {"total": "40.00", "currency": "USD"}, "create_time": "2026-09-27T15:00:00Z"}
    state["sales"]["SALE0000000002"] = {"id": "SALE0000000002", "state": "completed", "billing_agreement_id": "I-BRAVO00000001",
                                        "amount": {"total": "150.00", "currency": "USD"}, "create_time": "2026-10-06T15:00:00Z"}
    first = event("PAYMENT.SALE.COMPLETED", {"id": "SALE0000000001", "billing_agreement_id": "I-BRAVO00000001"})
    webhook(first)
    webhook(event("PAYMENT.SALE.COMPLETED", {"id": "SALE0000000002", "billing_agreement_id": "I-BRAVO00000001"}))
    webhook(event("PAYMENT.SALE.COMPLETED", {"id": "SALE0000000001", "billing_agreement_id": "I-BRAVO00000001"}))
    pays = sql("SELECT paypal_transaction_id, amount_cents, kind, enrollment_id FROM payments ORDER BY paid_at")
    check("each payment is recorded once, in exact cents", [(p["amount_cents"]) for p in pays] == [4000, 15000], pays)
    check("the first, equal to the setup fee, is the setup fee; the next is monthly",
          [p["kind"] for p in pays] == ["setup_fee", "recurring"] and all(p["enrollment_id"] == EB for p in pays), pays)

    print("\n=== subscriptions from the old Join page, and strangers ===")
    subscription("I-JOINPAGE00001", "joinpage", plan="P-3A8355760P817903NNKZ4ZGQ")
    webhook(event("BILLING.SUBSCRIPTION.ACTIVATED", {"id": "I-JOINPAGE00001"}))
    j = sql("SELECT source, enrollment_id FROM billing_subscriptions WHERE paypal_subscription_id='I-JOINPAGE00001'")
    check("a Join-page subscription is recorded, unlinked, for staff to match", j == [{"source": "joinpage", "enrollment_id": None}], j)
    st, text = webhook(event("BILLING.SUBSCRIPTION.ACTIVATED", {"id": "I-NOBODYKNOWS01"}))
    check("an event for a subscription PayPal does not know is acknowledged and ignored", st == 200 and text == "ignored", (st, text))

finally:
    server.shutdown()

print("\n=== the pieces (imported directly) ===")
UNIT = r"""
import { crc32 } from './src/lib/crc32.js';
import { toCents, certUrlAllowed, paypalConfig } from './src/payments/paypal.js';
import { enrollmentStatusFor } from './src/payments/billing.js';
import { handlePaypalWebhook } from './src/payments/webhook.js';
const live = paypalConfig({ PAYPAL_ENV: 'live' });
const sandbox = paypalConfig({});
const off = await handlePaypalWebhook(new Request('https://api.tnsaints.com/api/paypal/webhook', { method: 'POST', body: '{}' }),
  { PAYPAL_WEBHOOK_ENABLED: 'false' });
console.log(JSON.stringify({
  crc: crc32(new TextEncoder().encode('123456789')),
  cents: [toCents('40.00'), toCents('150'), toCents('0.5'), toCents('-12.34'), toCents('1e3'), toCents('40.001'), toCents('')],
  certs: [
    certUrlAllowed('https://api.paypal.com/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('https://api-m.paypal.com/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('http://api.paypal.com/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('https://api.paypal.com.evil.example/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('https://api.paypal.com/v1/other', live),
    certUrlAllowed('https://api.paypal.com:8443/v1/notifications/certs/CERT-1', live),
    certUrlAllowed('https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', sandbox),
  ],
  envs: [sandbox.env, sandbox.base, live.base, paypalConfig({ PAYPAL_ENV: 'LIVE' }).env,
         paypalConfig({ PAYPAL_API_BASE: 'https://evil.example' }).base],
  statuses: ['ACTIVE', 'APPROVED', 'SUSPENDED', 'CANCELLED', 'EXPIRED', 'APPROVAL_PENDING'].map(enrollmentStatusFor),
  killSwitch: off.status,
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-400:])
if u:
    check("CRC-32 matches the standard check value", u["crc"] == 3421780262, u["crc"])
    check("PayPal's decimal strings become exact cents; anything odd is refused",
          u["cents"] == [4000, 15000, 50, -1234, None, None, None], u["cents"])
    check("certificates only from PayPal's own API hosts, over HTTPS, default port, right path, right environment",
          u["certs"] == [True, True, False, False, False, False, False, True], u["certs"])
    check("sandbox by default; live only when exactly 'live'; a non-loopback override is ignored",
          u["envs"] == ["sandbox", "https://api-m.sandbox.paypal.com", "https://api-m.paypal.com", "sandbox",
                        "https://api-m.sandbox.paypal.com"], u["envs"])
    check("PayPal statuses map to enrollment states",
          u["statuses"] == ["active", "active", "past_due", "cancelled", "cancelled", None], u["statuses"])
    check("with the webhook switched off, PayPal is told to retry later (503)", u["killSwitch"] == 503, u["killSwitch"])

check.finish()
