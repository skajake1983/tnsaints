"""Paying for an event online (the Events plan, phase EV6): events/payments.js.

A small Stripe stand-in runs on 127.0.0.1:8798 (.dev.vars points the Worker
at it, with test keys; tests/test_stripe.py refuses to run otherwise, and so
does this).

Asserted:
- a paid camp's sign-up holds its place and sends the family to Stripe
  Checkout: card only, a payment, the parent's email and the event's name —
  never the child's — and a session that ends before the hold does;
- the held place counts: the next family waits;
- Stripe's word (a signed webhook, the session re-read from Stripe) marks the
  place paid and records the payment against the sign-up; a forged or
  mismatched session changes nothing;
- a pay link re-opens payment for a place still held;
- a camp paid at check-in is confirmed at once and says what is owed;
- online payment is refused when payments aren't switched to Stripe, both at
  sign-up and when publishing.
Lapsed holds and pay-link promotions are proved on Node's SQLite
(tests/test_events_unit.mjs).
"""
import calendar
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, Checker, require_portal, sql

preflight(BASE)
settings = require_portal()
MOCK = "http://127.0.0.1:8798"
KEY = "sk_test_mockstandin000000"
WHSEC = "whsec_mockstandin000000"
if (settings.get("STRIPE_API_BASE") != MOCK or settings.get("STRIPE_SECRET_KEY_SANDBOX") != KEY
        or settings.get("STRIPE_WEBHOOK_SECRET_SANDBOX") != WHSEC or settings.get("STRIPE_WEBHOOK_ENABLED") != "true"):
    sys.exit("\nREFUSING TO RUN.\n  Put the Stripe stand-in settings in .dev.vars and restart wrangler dev.\n")
check = Checker()
ME = staff_email()
A = "/__admin"
ORIGIN = "https://tnsaints.com"
CAMP, DOOR = "2099-09-01-camp", "2099-09-02-camp"
W = "pay-waiver-v1"


class State:
    sessions = {}
    created = []


class Stripe(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self._send(401, {"error": {"code": "api_key"}})
        if path.startswith("/v1/checkout/sessions/"):
            s = State.sessions.get(path.rsplit("/", 1)[1])
            return self._send(200, s) if s else self._send(404, {"error": {"code": "resource_missing"}})
        return self._send(404, {"error": {"code": "resource_missing"}})

    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self._send(401, {"error": {"code": "api_key"}})
        n = int(self.headers.get("Content-Length") or 0)
        params = dict(urllib.parse.parse_qsl(self.rfile.read(n).decode(), keep_blank_values=True))
        if urllib.parse.urlparse(self.path).path == "/v1/checkout/sessions":
            sid = f"cs_test_{len(State.sessions) + 1:08d}abcdefgh"
            s = {"id": sid, "object": "checkout.session", "status": "open", "payment_status": "unpaid", "mode": params.get("mode"),
                 "client_reference_id": params.get("client_reference_id"), "url": f"https://checkout.stripe.com/c/pay/{sid}",
                 "amount_total": int(params.get("line_items[0][price_data][unit_amount]", 0)), "currency": "usd", "payment_intent": None}
            State.sessions[sid] = s
            State.created.append(params)
            return self._send(200, s)
        return self._send(404, {"error": {"code": "resource_missing"}})


stripe_srv = ThreadingHTTPServer(("127.0.0.1", 8798), Stripe)
threading.Thread(target=stripe_srv.serve_forever, daemon=True).start()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def api(method, path, body=None, ip="10.95.0.1"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Origin", ORIGIN)
    req.add_header("CF-Connecting-IP", ip)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def admin_post(path):
    req = urllib.request.Request(BASE + A + path, data=b"", method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers)


def webhook(event):
    body = json.dumps(event)
    t = int(time.time())
    sig = hmac.new(WHSEC.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(BASE + "/api/stripe/webhook", data=body.encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Stripe-Signature", f"t={t},v1={sig}")
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        r = e
    return getattr(r, "status", None) or r.code


def camper(name, email, **over):
    p = {"session_time": "Morning", "player_name": name, "grade": "5th", "parent_name": "Pat Parent", "parent_email": email,
         "phone": "(615) 555-0100", "emergency_contact_name": "Erin Contact", "emergency_contact_phone": "(615) 555-0199",
         "assumption_of_risk": True, "medical_release": True, "photo_release": False, "signature": "Pat Parent",
         "waiver_version_id": W, "turnstile_token": "dummy-token"}
    p.update(over)
    return p


# --- setup ----------------------------------------------------------------------------------------
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
    f"VALUES ('{W}', 'Saints LLC', 'Camp waiver', 'text', '{'b' * 64}', 'n', 'n')")
for pid, policy, day in [(CAMP, "online", "2099-09-01"), (DOOR, "at_check_in", "2099-09-02")]:
    sql("INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, price_cents, grade_min, grade_max, "
        "waiver_version_id, public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on, "
        f"location, payment_policy) VALUES ('{pid}', 'camp', 'camp', 'Winter Camp {day}', 'open', 'approval', 'one_time', 7500, 3, 8, "
        f"'{W}', 1, '2099-08-30T23:59:00.000Z', 1, 'n', 'n', 'spot', '{day}', 'Franklin, TN', '{policy}')")
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, starts_on, capacity, status, created_at, updated_at) "
        f"VALUES ('{pid}', 'Morning', 'Morning', '09:00', '{day}', 1, 'active', 'n', 'n')")

try:
    print("\n=== not while payments are on PayPal ===")
    sql("INSERT OR REPLACE INTO app_settings (key, value, updated_by, updated_at) VALUES ('payments.provider', 'paypal', 'test', 'n')")
    st, r = api("POST", f"/api/events/{CAMP}/register", camper("Early Kid", "early@example.com"), ip="10.95.1.1")
    check("a camp paid online refuses sign-ups until Stripe is switched on", st == 503
          and sql(f"SELECT COUNT(*) AS n FROM registrations WHERE event_id = '{CAMP}'")[0]["n"] == 0, (st, r))
    sql(f"UPDATE programs SET status = 'draft' WHERE id = '{CAMP}'")
    st, h = admin_post(f"/events/{CAMP}/publish")
    check("and refuses to publish", "msg=needs-stripe" in h.get("Location", ""), h.get("Location"))
    sql("INSERT OR REPLACE INTO app_settings (key, value, updated_by, updated_at) VALUES ('payments.provider', 'stripe', 'test', 'n')")
    st, h = admin_post(f"/events/{CAMP}/publish")
    check("with Stripe on, it publishes", "msg=published" in h.get("Location", ""), h.get("Location"))

    print("\n=== a paid place ===")
    st, r = api("POST", f"/api/events/{CAMP}/register", camper("Ava Camper", "ava@example.com"), ip="10.95.2.1")
    check("signing up holds the place and sends the family to Stripe", st == 200 and r.get("status") == "pending_payment"
          and r.get("checkout_url", "").startswith("https://checkout.stripe.com/"), r)
    params = State.created[-1] if State.created else {}
    check("a card payment for the event, to the parent's email", params.get("mode") == "payment"
          and params.get("customer_email") == "ava@example.com" and params.get("payment_method_types[0]") == "card"
          and "payment_method_types[1]" not in params and params.get("line_items[0][price_data][unit_amount]") == "7500"
          and params.get("line_items[0][price_data][product_data][name]") == f"Winter Camp 2099-09-01", params)
    check("never the child's name", "Ava" not in json.dumps(params) and "Camper" not in json.dumps(params))
    row = sql(f"SELECT status, payment_state, amount_due_cents, hold_expires_at FROM registrations WHERE event_id = '{CAMP}'")[0]
    exp = int(params.get("expires_at", "0"))
    hold = calendar.timegm(time.strptime(row["hold_expires_at"][:19], "%Y-%m-%dT%H:%M:%S"))
    check("the place is held, owed, and the session ends before the hold does",
          row["status"] == "confirmed" and row["payment_state"] == "pending" and row["amount_due_cents"] == 7500 and exp < hold, (row, exp, hold))
    st, r = api("POST", f"/api/events/{CAMP}/register", camper("Ben Camper", "ben@example.com"), ip="10.95.2.2")
    check("the held place counts: the next family waits, and owes nothing yet", r.get("status") == "waitlist"
          and sql(f"SELECT payment_state FROM registrations WHERE event_id = '{CAMP}' AND parent_email_norm = 'ben@example.com'")
          == [{"payment_state": None}], r)

    print("\n=== Stripe's word, never the browser's ===")
    sid = list(State.sessions)[-1]
    check("a webhook for a session still open changes nothing",
          webhook({"id": "evt_paytest00000001", "type": "checkout.session.completed", "data": {"object": {"id": sid}}}) == 200
          and sql(f"SELECT payment_state FROM registrations WHERE event_id = '{CAMP}' AND parent_email_norm = 'ava@example.com'")
          == [{"payment_state": "pending"}])
    State.sessions[sid].update({"status": "complete", "payment_status": "paid", "payment_intent": "pi_test_camp_0001"})
    st = webhook({"id": "evt_paytest00000002", "type": "checkout.session.completed", "data": {"object": {"id": sid}}})
    reg = sql(f"SELECT id, payment_state, hold_expires_at FROM registrations WHERE event_id = '{CAMP}' AND parent_email_norm = 'ava@example.com'")[0]
    pay = sql("SELECT provider, amount_cents, registration_id FROM payments WHERE paypal_transaction_id = 'pi_test_camp_0001'")
    check("once Stripe says it's paid, the place is theirs", st == 200 and reg["payment_state"] == "paid" and reg["hold_expires_at"] is None, reg)
    check("and the payment is recorded against the sign-up", pay == [{"provider": "stripe", "amount_cents": 7500, "registration_id": reg["id"]}], pay)
    State.sessions[sid]["client_reference_id"] = "someone-else"
    webhook({"id": "evt_paytest00000003", "type": "checkout.session.completed", "data": {"object": {"id": sid}}})
    check("a session whose reference doesn't match is ignored",
          sql("SELECT COUNT(*) AS n FROM payments WHERE provider = 'stripe'")[0]["n"] == 1)

    print("\n=== a pay link ===")
    sql(f"UPDATE program_groups SET capacity = 2 WHERE program_id = '{CAMP}'")
    st, r = api("POST", f"/api/events/{CAMP}/register", camper("Cy Camper", "cy@example.com"), ip="10.95.3.1")
    tok = sql(f"SELECT cancel_token FROM registrations WHERE event_id = '{CAMP}' AND parent_email_norm = 'cy@example.com'")[0]["cancel_token"]
    before = len(State.created)
    st, r = api("POST", f"/api/events/{CAMP}/pay", {"token": tok}, ip="10.95.3.2")
    check("a place still held can be paid again from its link", st == 200 and r.get("checkout_url", "").startswith("https://checkout.stripe.com/")
          and len(State.created) == before + 1, r)
    st, r = api("POST", f"/api/events/{CAMP}/pay", {"token": "f" * 64}, ip="10.95.3.3")
    check("a link for nothing held is refused", st == 409, st)

    print("\n=== paid at check-in ===")
    st, r = api("POST", f"/api/events/{DOOR}/register", camper("Dee Camper", "dee@example.com"), ip="10.95.4.1")
    check("confirmed at once, and told what to bring", st == 200 and r.get("status") == "confirmed" and "$75 to check-in" in r.get("message", ""), r)
    check("owed at check-in", sql(f"SELECT payment_state, amount_due_cents FROM registrations WHERE event_id = '{DOOR}'")
          == [{"payment_state": "at_check_in", "amount_due_cents": 7500}])
finally:
    stripe_srv.shutdown()

check.finish()
