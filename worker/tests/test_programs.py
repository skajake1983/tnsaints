"""Programs as data: camps and clinics, self-serve sign-up, one-time payments.

Against a mock PayPal Orders API on 127.0.0.1:8797 (the Worker's real code
creates, re-reads, captures and verifies; webhooks are signed exactly as PayPal
signs them and checked by the real verifier).

Asserted: staff create a camp as a draft and open it only once it is
complete; families see open, listed programs only; signing up holds a seat in
a scheduled group for 30 minutes (atomic: a full group writes nothing, and a
family can join its waiting list instead); the order's amount comes from the
program and PayPal never sees a child's name; a capture is verified before the
place is active and the payment recorded, once; an amount that does not match
is refused; a lapsed hold gives the seat back; a family who closed the tab is
still placed by the webhook; refunds are recorded; free programs confirm at
once.
"""
import base64
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
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
settings = require_portal()
MOCK = "http://127.0.0.1:8797"
if settings.get("PAYPAL_API_BASE") != MOCK or settings.get("PAYPAL_WEBHOOK_ENABLED") != "true":
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs the mock PayPal settings (see .dev.vars.example).\n")
WEBHOOK_ID = settings["PAYPAL_WEBHOOK_ID_SANDBOX"]
CLIENT = (settings["PAYPAL_CLIENT_ID_SANDBOX"], settings["PAYPAL_CLIENT_SECRET_SANDBOX"])
check = Checker()
ME = staff_email()
A = "/__admin"

TMP = tempfile.mkdtemp(prefix="tns-orders-")
KEY, CERT = os.path.join(TMP, "key.pem"), os.path.join(TMP, "cert.pem")
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CERT,
                "-days", "2", "-subj", "/CN=mock-paypal-orders"], check=True, capture_output=True)
CERT_PEM = open(CERT, encoding="ascii").read()
CERT_PATH = f"/v1/notifications/certs/CERT-{uuid.uuid4().hex[:12]}"

state = {"orders": {}, "by_request": {}, "bodies": [], "refunds": {}, "n": 0}


def money(cents):
    return f"{cents / 100:.2f}"


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

    def _authed(self):
        return self.headers.get("Authorization") == "Bearer mock-access-token"

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/v1/oauth2/token":
            expected = "Basic " + base64.b64encode(f"{CLIENT[0]}:{CLIENT[1]}".encode()).decode()
            if self.headers.get("Authorization") != expected:
                return self._send(401, {"error": "invalid_client"})
            return self._send(200, {"access_token": "mock-access-token", "expires_in": 32400})
        if not self._authed():
            return self._send(401)
        if self.path == "/v2/checkout/orders":
            rid = self.headers.get("PayPal-Request-Id", "")
            if rid and rid in state["by_request"]:
                return self._send(200, state["orders"][state["by_request"][rid]])
            body = json.loads(raw)
            state["bodies"].append(raw.decode())
            state["n"] += 1
            oid = f"ORDER{state['n']:010d}"
            unit = body["purchase_units"][0]
            state["orders"][oid] = {"id": oid, "status": "CREATED", "purchase_units": [
                {"custom_id": unit["custom_id"], "description": unit.get("description"), "amount": unit["amount"]}]}
            if rid:
                state["by_request"][rid] = oid
            return self._send(201, state["orders"][oid])
        m = re.match(r"^/v2/checkout/orders/([A-Z0-9]+)/capture$", self.path)
        if m:
            order = state["orders"].get(m.group(1))
            if not order:
                return self._send(404)
            if order["status"] == "COMPLETED":
                return self._send(422, {"name": "UNPROCESSABLE_ENTITY", "details": [{"issue": "ORDER_ALREADY_CAPTURED"}]})
            if order["status"] != "APPROVED":
                return self._send(422, {"name": "UNPROCESSABLE_ENTITY", "details": [{"issue": "ORDER_NOT_APPROVED"}]})
            unit = order["purchase_units"][0]
            order["status"] = "COMPLETED"
            unit["payments"] = {"captures": [{"id": f"CAP{order['id'][5:]}", "status": "COMPLETED",
                                              "amount": unit["amount"], "create_time": "2026-10-07T15:00:00Z"}]}
            return self._send(201, order)
        return self._send(404)

    def do_GET(self):
        if self.path == CERT_PATH:
            return self._send(200, text=CERT_PEM, ctype="application/x-pem-file")
        if not self._authed():
            return self._send(401)
        m = re.match(r"^/v2/checkout/orders/([A-Z0-9]+)$", self.path)
        if m:
            order = state["orders"].get(m.group(1))
            return self._send(200, order) if order else self._send(404)
        m = re.match(r"^/v2/payments/refunds/([A-Z0-9]+)$", self.path)
        if m:
            refund = state["refunds"].get(m.group(1))
            return self._send(200, refund) if refund else self._send(404)
        return self._send(404)

    def log_message(self, *args):
        pass


def webhook(event):
    body = json.dumps(event).encode()
    tid, ttime = str(uuid.uuid4()), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    message = f"{tid}|{ttime}|{WEBHOOK_ID}|{zlib.crc32(body) & 0xffffffff}".encode()
    sig = base64.b64encode(subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY], input=message,
                                          capture_output=True, check=True).stdout).decode()
    req = urllib.request.Request(BASE + "/api/paypal/webhook", data=body, method="POST")
    for k, v in {"Content-Type": "application/json", "PAYPAL-TRANSMISSION-ID": tid, "PAYPAL-TRANSMISSION-TIME": ttime,
                 "PAYPAL-TRANSMISSION-SIG": sig, "PAYPAL-CERT-URL": MOCK + CERT_PATH, "PAYPAL-AUTH-ALGO": "SHA256withRSA"}.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}, doseq=True).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace")


def portal_json(path, body, cookies):
    req = urllib.request.Request(BASE + P + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Sec-Fetch-Site", "same-origin")
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {}


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


def family(email, child_names):
    s = session_cookies(mint_session(make_account(email)))
    post(P + "/family/setup", {"guardian_name": "Pat Parent", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=s)
    post(P + "/contacts", {"ec1_name": "Grandma", "ec1_phone": "(615) 555-0111"}, cookies=s)
    ids = []
    for name in child_names:
        post(P + "/children", {"child_name": name, "date_of_birth": "2016-04-04", "grade": "4", "school": "Camp School",
                               "shirt_size": "YM"}, cookies=s)
        kid = one(f"SELECT id FROM players WHERE display_name='{name}'")["id"]
        post(P + f"/children/{kid}/medical", {"medical_status": "none_declared"}, cookies=s)
        ids.append(kid)
    return s, ids


def sign(group_id, waiver="summer-camp-2027-v1"):
    return {"group": str(group_id), "waiver_version": waiver, "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
            "photo_release": "no", "signature": "Pat Parent", "relationship": "Mother"}


for t in ["paypal_orders", "payments", "billing_subscriptions", "paypal_events", "enrollments", "consent_records", "program_groups",
          "player_medical", "household_emergency_contacts", "household_invites", "household_members", "sessions",
          "account_identities", "rate_limits", "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM programs WHERE id != 'academy'")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

server = ThreadingHTTPServer(("127.0.0.1", 8797), PayPal)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    print("\n=== staff make a camp ===")
    st, h, html = admin("POST", "/programs/new", {"name": "Summer Camp", "kind": "camp", "billing": "one_time", "id": "Bad Id!"})
    check("a program needs a proper id", st == 400 and "lowercase letters" in html, st)
    st, h, _ = admin("POST", "/programs/new", {"name": "Summer Camp 2027", "kind": "camp", "billing": "one_time", "id": "summer-camp-2027"})
    check("a camp is created as a self-serve draft", st == 303 and "msg=created" in h.get("location", "")
          and one("SELECT status, enrollment_mode, billing FROM programs WHERE id='summer-camp-2027'")
          == {"status": "draft", "enrollment_mode": "self_serve", "billing": "one_time"}, (st, h.get("location")))
    st, h, _ = admin("POST", "/programs/new", {"name": "Again", "kind": "camp", "billing": "one_time", "id": "summer-camp-2027"})
    check("the same id twice is refused", st == 400, st)
    C = "/programs/summer-camp-2027"
    admin("POST", C + "/details", {"name": "Summer Camp 2027", "description": "A week of skills.", "public": "1",
                                   "waitlist_enabled": "1", "enrollment_mode": "self_serve",
                                   "registration_closes_at": "2099-06-01T18:00"})
    admin("POST", C + "/waivers", {"legal_entity": "Tennessee Saints Basketball Academy LLC", "title": "Camp waiver",
                                   "body_text": "Camp waiver text."})
    admin("POST", C + "/settings", {"price": "150.00", "offer_hold_days": "7", "grade_min": "3", "grade_max": "6",
                                    "waiver_version_id": "summer-camp-2027-v1"})
    admin("POST", C + "/groups", {"name": "Morning session", "schedule_summary": "June 8-12, 9 AM-noon", "capacity": "1",
                                  "location": "Gym"})
    GROUP = one("SELECT id FROM program_groups WHERE program_id='summer-camp-2027'")["id"]
    st, h, _ = admin("POST", C + "/status", {"status": "open"})
    p = one("SELECT status, price_cents, public, registration_closes_at FROM programs WHERE id='summer-camp-2027'")
    check("with a price, a group and a waiver it opens", p["status"] == "open" and p["price_cents"] == 15000 and p["public"] == 1, p)
    check("the sign-up close time is stored as an instant (Central 6 PM = 23:00 UTC in June)",
          p["registration_closes_at"] == "2099-06-01T23:00:00.000Z", p["registration_closes_at"])
    st, _, html = admin("GET", "/programs")
    check("the programs list shows it", st == 200 and "Summer Camp 2027" in html and "Families pick a group and pay" in html, st)
    admin("POST", "/programs/new", {"name": "Secret Clinic", "kind": "clinic", "billing": "free", "id": "secret-clinic"})

    print("\n=== families sign up ===")
    SA, (ADA, ABE) = family("camp-a@example.com", ["Ada Camper", "Abe Camper"])
    SB, (BEA,) = family("camp-b@example.com", ["Bea Camper"])
    st, _, _, html = get(P + "/programs", cookies=SA)
    check("open, listed programs appear, with seats left", st == 200 and "Summer Camp 2027" in html and "1 place left" in html, st)
    check("drafts do not", "Secret Clinic" not in html)
    check("each child can sign up", f"/children/{ADA}/register/summer-camp-2027" in html)
    st, _, _, html = get(P + f"/children/{ADA}/register/summer-camp-2027", cookies=SA)
    check("the sign-up page shows the group and the waiver", st == 200 and "Morning session" in html and "Camp waiver text." in html, st)
    st, h, _, html = post(P + f"/children/{ADA}/register/summer-camp-2027", {**sign(GROUP), "group": ""}, cookies=SA)
    check("a group must be chosen", st == 400 and "Choose a group" in html, st)
    st, h, _, _ = post(P + f"/children/{ADA}/register/summer-camp-2027", sign(GROUP), cookies=SA)
    e = one(f"SELECT ref, status, decided_by, offer_expires_at, consent_record_id FROM enrollments WHERE player_id={ADA}")
    check("signing up holds the seat and goes to payment", st == 303 and e and h.get("Location", "").endswith(f"/pay/{e['ref']}")
          and e["status"] == "offered" and e["decided_by"] == "self-serve" and e["consent_record_id"], (st, e))
    held = one(f"SELECT (julianday(offer_expires_at) - julianday('now')) * 1440 AS mins FROM enrollments WHERE player_id={ADA}")["mins"]
    check("for 30 minutes", 28 < held <= 30.5, held)
    consents_before = one("SELECT COUNT(*) AS n FROM consent_records")["n"]
    st, h, _, _ = post(P + f"/children/{BEA}/register/summer-camp-2027", sign(GROUP), cookies=SB)
    b = one(f"SELECT status, preferred_group_ids FROM enrollments WHERE player_id={BEA}")
    check("the group is full: the next family joins its waiting list instead", "notice=waitlisted" in h.get("Location", "")
          and b == {"status": "waitlist", "preferred_group_ids": f"[{GROUP}]"}, (h.get("Location"), b))
    check("with exactly one more signed waiver", one("SELECT COUNT(*) AS n FROM consent_records")["n"] == consents_before + 1)

    print("\n=== paying once ===")
    REF = e["ref"]
    st, _, _, html = get(P + f"/pay/{REF}", cookies=SA)
    check("the pay page offers PayPal's pay button for one payment", st == 200 and f"/pay/{REF}/order" in html
          and "intent=capture" in html and "currency=USD" in html, st)
    st, r = portal_json(f"/pay/{REF}/order", {}, SA)
    check("the Worker creates the order", st == 200 and r.get("ok") and r.get("order_id", "").startswith("ORDER"), (st, r))
    OID = r["order_id"]
    body = state["bodies"][-1]
    unit = json.loads(body)["purchase_units"][0]
    check("for the program's price, with the place's ref", unit["amount"] == {"currency_code": "USD", "value": "150.00"}
          and unit["custom_id"] == REF and unit["description"] == "Summer Camp 2027", unit)
    check("and PayPal never sees the child's name", "Ada" not in body and "Camper" not in body, body)
    st, r2 = portal_json(f"/pay/{REF}/order", {}, SA)
    check("asking again returns the same order", r2.get("order_id") == OID, r2)
    st, r = portal_json(f"/pay/{REF}/captured", {"order_id": OID}, SA)
    check("an order the family has not approved is not captured", st == 400 and not r.get("ok")
          and one(f"SELECT status FROM enrollments WHERE player_id={ADA}")["status"] == "offered", (st, r))
    state["orders"][OID]["status"] = "APPROVED"
    st, r = portal_json(f"/pay/{REF}/captured", {"order_id": "ORDER9999999999"}, SA)
    check("a stranger's order id is refused", st == 404, (st, r))
    st, r = portal_json(f"/pay/{REF}/captured", {"order_id": OID}, SA)
    check("once approved, it is captured and the place is confirmed", st == 200 and r.get("ok")
          and one(f"SELECT status FROM enrollments WHERE player_id={ADA}")["status"] == "active", (st, r))
    pays = sql(f"SELECT amount_cents, kind, enrollment_id FROM payments WHERE paypal_transaction_id LIKE 'CAP%'")
    check("one payment recorded, in cents, as one-time", len(pays) == 1 and pays[0]["amount_cents"] == 15000 and pays[0]["kind"] == "one_time", pays)
    st, r = portal_json(f"/pay/{REF}/captured", {"order_id": OID}, SA)
    check("confirming again is harmless", st == 200 and len(sql("SELECT 1 FROM payments")) == 1, (st, r))
    st, _, _, html = get(P + "/", cookies=SA)
    check("the family page shows the camp place", "Summer Camp 2027: Morning session" in html)

    print("\n=== a mismatched order is refused ===")
    admin("POST", C + "/groups", {"name": "Afternoon session", "schedule_summary": "June 8-12, 1-4 PM", "capacity": "5"})
    G2 = one("SELECT id FROM program_groups WHERE name='Afternoon session'")["id"]
    post(P + f"/children/{ABE}/register/summer-camp-2027", sign(G2), cookies=SA)
    REF2 = one(f"SELECT ref FROM enrollments WHERE player_id={ABE}")["ref"]
    st, r = portal_json(f"/pay/{REF2}/order", {}, SA)
    OID2 = r["order_id"]
    state["orders"][OID2]["status"] = "APPROVED"
    state["orders"][OID2]["purchase_units"][0]["amount"]["value"] = "1.00"
    st, r = portal_json(f"/pay/{REF2}/captured", {"order_id": OID2}, SA)
    check("an order whose amount does not match the price is not captured", st == 400 and r.get("ok") is False
          and state["orders"][OID2]["status"] == "APPROVED"
          and one(f"SELECT status FROM enrollments WHERE player_id={ABE}")["status"] == "offered", (st, r))

    print("\n=== a lapsed hold gives the seat back ===")
    sql(f"UPDATE enrollments SET offer_expires_at='2000-01-01T00:00:00.000Z' WHERE player_id={ABE}")
    admin("GET", "/enrollments?program=summer-camp-2027")
    x = one(f"SELECT status, decline_reason FROM enrollments WHERE player_id={ABE}")
    check("an unpaid self-serve hold is cancelled, not waitlisted", x == {"status": "cancelled", "decline_reason": "hold-lapsed"}, x)
    st, _, _, html = get(P + f"/pay/{REF2}", cookies=SA)
    check("and its pay page says the hold has ended", st == 410 and "hold has ended" in html, st)

    print("\n=== the family who closed the tab ===")
    post(P + f"/children/{ABE}/register/summer-camp-2027", sign(G2), cookies=SA)
    REF3 = one(f"SELECT ref FROM enrollments WHERE player_id={ABE} AND status='offered'")["ref"]
    st, r = portal_json(f"/pay/{REF3}/order", {}, SA)
    OID3 = r["order_id"]
    state["orders"][OID3]["status"] = "APPROVED"
    st, text = webhook({"id": f"WH-{uuid.uuid4().hex[:20].upper()}", "event_type": "CHECKOUT.ORDER.APPROVED",
                        "resource": {"id": OID3, "status": "APPROVED"}})
    check("the approved-order webhook captures it and confirms the place", st == 200 and text == "synced"
          and state["orders"][OID3]["status"] == "COMPLETED"
          and one(f"SELECT status FROM enrollments WHERE ref='{REF3}'")["status"] == "active", (st, text))
    st, r = portal_json(f"/pay/{REF3}/captured", {"order_id": OID3}, SA)
    check("and the page's late confirmation agrees, without a second payment", st == 200 and r.get("ok")
          and len(sql(f"SELECT 1 FROM payments WHERE enrollment_id=(SELECT id FROM enrollments WHERE ref='{REF3}')")) == 1, (st, r))

    print("\n=== refunds ===")
    state["refunds"]["REF0000000001"] = {"id": "REF0000000001", "status": "COMPLETED",
                                         "amount": {"value": "150.00", "currency_code": "USD"},
                                         "create_time": "2026-10-08T15:00:00Z",
                                         "links": [{"rel": "up", "href": f"{MOCK}/v2/payments/captures/CAP{OID[5:]}"}]}
    st, text = webhook({"id": f"WH-{uuid.uuid4().hex[:20].upper()}", "event_type": "PAYMENT.CAPTURE.REFUNDED",
                        "resource": {"id": "REF0000000001"}})
    r = one("SELECT amount_cents, kind, enrollment_id FROM payments WHERE paypal_transaction_id='REF0000000001'")
    check("a refund is recorded as a negative payment against the place", st == 200 and r and r["amount_cents"] == -15000
          and r["kind"] == "refund" and r["enrollment_id"] == one(f"SELECT id FROM enrollments WHERE ref='{REF}'")["id"], (st, r))

    print("\n=== a free clinic confirms at once ===")
    admin("POST", "/programs/new", {"name": "Free Skills Clinic", "kind": "clinic", "billing": "free", "id": "free-clinic"})
    F = "/programs/free-clinic"
    admin("POST", F + "/details", {"name": "Free Skills Clinic", "public": "1", "enrollment_mode": "self_serve"})
    admin("POST", F + "/waivers", {"legal_entity": "Tennessee Saints Basketball Academy LLC", "title": "Clinic waiver", "body_text": "Clinic text."})
    admin("POST", F + "/settings", {"offer_hold_days": "7", "waiver_version_id": "free-clinic-v1"})
    admin("POST", F + "/groups", {"name": "Saturday", "schedule_summary": "Saturday 10 AM", "capacity": "10"})
    admin("POST", F + "/status", {"status": "open"})
    FG = one("SELECT id FROM program_groups WHERE program_id='free-clinic'")["id"]
    st, h, _, _ = post(P + f"/children/{BEA}/register/free-clinic", sign(FG, "free-clinic-v1"), cookies=SB)
    check("signing up for a free program confirms the place, no payment", "notice=registered" in h.get("Location", "")
          and one(f"SELECT status FROM enrollments WHERE player_id={BEA} AND program_id='free-clinic'")["status"] == "active",
          h.get("Location"))

    print("\n=== staff see each program's queue ===")
    st, _, html = admin("GET", "/enrollments?program=summer-camp-2027")
    check("the camp's waiting list is in its own queue", st == 200 and "Bea Camper" in html and "Summer Camp 2027" in html, st)
finally:
    server.shutdown()

check.finish()
