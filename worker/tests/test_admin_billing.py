"""Billing reconciliation (payments/reconcile.js, admin/billing-ui.js) and signing
the waiver for a place staff created (portal /children/:id/waiver/:program).

Families who paid on the old Join page are matched by hand: staff paste the
subscription id, see the payer live (never stored), record it, and link it to a
child and a group — with the seat checked atomically. The family is then asked
to sign the waiver, because a place created by staff has no signature behind it.
"""
import base64
import hashlib
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
settings = require_portal()
if settings.get("PAYPAL_API_BASE") != "http://127.0.0.1:8797":
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs the mock PayPal settings (see .dev.vars.example).\n")
CLIENT = (settings["PAYPAL_CLIENT_ID_SANDBOX"], settings["PAYPAL_CLIENT_SECRET_SANDBOX"])
check = Checker()
ME = staff_email()
subs = {}


class PayPal(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        ok = self.headers.get("Authorization") == "Basic " + base64.b64encode(f"{CLIENT[0]}:{CLIENT[1]}".encode()).decode()
        return self._send(200, {"access_token": "mock-access-token", "expires_in": 32400}) if ok else self._send(401, {})

    def do_GET(self):
        m = re.match(r"^/v1/billing/subscriptions/([A-Z0-9-]+)$", self.path)
        if m and self.headers.get("Authorization") == "Bearer mock-access-token":
            s = subs.get(m.group(1))
            return self._send(200, s) if s else self._send(404, {})
        return self._send(404, {})

    def log_message(self, *args):
        pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + "/__admin" + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def msg(h):
    return urllib.parse.parse_qs(urllib.parse.urlparse(h.get("Location", "")).query).get("msg", [None])[0]


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
    WAIVER = "TEST WAIVER. Basketball involves risk. I authorise emergency care."
    sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
        f"('bill-test-v1', 'Test entity', 'Test waiver', '{WAIVER}', '{hashlib.sha256(WAIVER.encode()).hexdigest()}', "
        "datetime('now'), datetime('now'))")
    sql("UPDATE programs SET status='open', price_cents=15000, waiver_version_id='bill-test-v1', "
        "paypal_plan_id_sandbox='P-SANDBOXPLAN000001' WHERE id='academy'")
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at) "
        "VALUES ('academy', 'Tuesday group', 'Tuesdays 6:00-7:30 PM', 1, datetime('now'), datetime('now'))")
    GID = sql("SELECT id FROM program_groups")[0]["id"]
    sql("DELETE FROM staff")
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    fams = {}
    for email, name in (("adams@example.com", "Adams"), ("brown@example.com", "Brown")):
        s = session_cookies(mint_session(make_account(email)))
        post(P + "/family/setup", {"guardian_name": f"Pat {name}", "phone": "(615) 555-0100", "relationship": "Mother"}, cookies=s)
        post(P + "/children", {"child_name": f"{name} Kid", "date_of_birth": "2016-04-04", "grade": "4",
                               "school": "Test School", "shirt_size": "YM"}, cookies=s)
        fams[name] = (s, sql(f"SELECT id FROM players WHERE display_name='{name} Kid'")[0]["id"])

    subs["I-JOINPAGE00001"] = {"id": "I-JOINPAGE00001", "status": "ACTIVE", "plan_id": "P-3A8355760P817903NNKZ4ZGQ",
                               "custom_id": "joinpage", "start_time": "2026-09-01T12:00:00Z",
                               "subscriber": {"name": {"given_name": "Pat", "surname": "Payer"},
                                              "email_address": "pat.payer@example.com"},
                               "billing_info": {"next_billing_time": "2026-10-01T12:00:00Z"}}
    subs["I-NOCUSTOM00001"] = {"id": "I-NOCUSTOM00001", "status": "ACTIVE", "plan_id": "P-3A8355760P817903NNKZ4ZGQ"}

    print("\n=== looking a subscription up ===")
    st, _, html = admin("GET", "/billing")
    check("the billing page opens, with nothing to match yet", st == 200 and "Nothing waiting to be matched" in html, st)
    st, _, html = admin("GET", "/billing?lookup=not-an-id")
    check("a malformed id is refused plainly", "did not look like a PayPal subscription id" in html)
    st, _, html = admin("GET", "/billing?lookup=I-UNKNOWN000001")
    check("an id PayPal does not know says so", "PayPal does not know that subscription" in html)
    st, _, html = admin("GET", "/billing?lookup=I-JOINPAGE00001")
    check("a known id shows the payer, live from PayPal, so staff can recognise the family",
          "Pat Payer" in html and "pat.payer@example.com" in html and "old Join page" not in html.split("Placed via")[0])
    check("a lookup stores nothing", sql("SELECT 1 FROM billing_subscriptions") == [])
    a = sql("SELECT subject_id, detail FROM audit_log WHERE action='billing.lookup' ORDER BY id DESC LIMIT 1")
    check("but leaves a trace, carrying only the id", a and a[0]["subject_id"] == "I-JOINPAGE00001" and "pat.payer" not in str(a), a)

    print("\n=== recording and linking ===")
    st, h, _ = admin("POST", "/billing/import", {"subscription_id": "I-JOINPAGE00001"})
    check("the subscription is recorded", msg(h) == "imported", msg(h))
    row = sql("SELECT * FROM billing_subscriptions WHERE paypal_subscription_id='I-JOINPAGE00001'")
    check("as a Join-page subscription, unlinked", row and row[0]["source"] == "joinpage" and row[0]["enrollment_id"] is None, row)
    check("with none of the payer's details", row and "pat.payer" not in json.dumps(row) and "Payer" not in json.dumps(row))
    BID = row[0]["id"]
    st, _, html = admin("GET", "/billing")
    check("it waits to be matched, with a child and group picker", "Waiting to be matched (1)" in html
          and "Adams Kid" in html and "Tuesday group (0/1)" in html)
    st, h, _ = admin("POST", f"/billing/{BID}/link", {"player_id": str(fams["Adams"][1]), "group_id": str(GID)})
    check("linking it to a child succeeds", msg(h) == "linked", msg(h))
    e = sql(f"SELECT id, status, group_id, consent_record_id, created_by FROM enrollments WHERE player_id={fams['Adams'][1]}")
    check("the child now has an active place in that group, created by staff, with no signature yet",
          e and e[0]["status"] == "active" and e[0]["group_id"] == GID and e[0]["consent_record_id"] is None
          and e[0]["created_by"] == ME, e)
    check("and the subscription points at it", sql(f"SELECT enrollment_id FROM billing_subscriptions WHERE id={BID}")
          == [{"enrollment_id": e[0]["id"]}])
    check("linking is audited", sql("SELECT 1 FROM audit_log WHERE action='billing.link'") != [])

    admin("POST", "/billing/import", {"subscription_id": "I-NOCUSTOM00001"})
    B2 = sql("SELECT id FROM billing_subscriptions WHERE paypal_subscription_id='I-NOCUSTOM00001'")[0]["id"]
    st, h, _ = admin("POST", f"/billing/{B2}/link", {"player_id": str(fams["Brown"][1]), "group_id": str(GID)})
    check("a full group refuses a second child", msg(h) == "full"
          and sql(f"SELECT 1 FROM enrollments WHERE player_id={fams['Brown'][1]}") == [], msg(h))
    st, h, _ = admin("POST", f"/billing/{BID}/link", {"player_id": str(fams["Brown"][1]), "group_id": str(GID)})
    check("a subscription already linked cannot be linked again", msg(h) == "state", msg(h))

    print("\n=== re-reading from PayPal ===")
    subs["I-JOINPAGE00001"]["status"] = "SUSPENDED"
    st, h, _ = admin("POST", f"/billing/{BID}/sync")
    check("a re-sync follows PayPal: suspended means payment due", msg(h) == "synced"
          and sql(f"SELECT status FROM enrollments WHERE id={e[0]['id']}")[0]["status"] == "past_due")
    subs["I-JOINPAGE00001"]["status"] = "ACTIVE"
    admin("POST", f"/billing/{BID}/sync")
    check("and back to active when PayPal says so", sql(f"SELECT status FROM enrollments WHERE id={e[0]['id']}")[0]["status"] == "active")

    print("\n=== the family signs the waiver ===")
    SA, KID = fams["Adams"]
    st, _, _, html = get(P + "/", cookies=SA)
    check("the family page asks for the waiver", "Action needed: sign the waiver" in html)
    st, _, _, html = get(P + f"/children/{KID}/waiver/academy", cookies=SA)
    check("the signing page shows the waiver", st == 200 and "Basketball involves risk" in html and "Sign the waiver" in html, st)
    st, _, _, _ = get(P + f"/children/{KID}/waiver/academy", cookies=fams["Brown"][0])
    check("another family cannot open it", st == 404, st)
    st, _, _, html = post(P + f"/children/{KID}/waiver/academy", {"waiver_version": "bill-test-v1"}, cookies=SA)
    check("unticked agreements and no signature are refused", st == 400 and 'href="#agree_risk"' in html, st)
    st, h, _, _ = post(P + f"/children/{KID}/waiver/academy",
                       {"waiver_version": "bill-test-v1", "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
                        "photo_release": "yes", "signature": "Pat Adams", "relationship": "Mother"}, cookies=SA)
    check("a signed waiver is accepted", st == 303 and "notice=signed" in h.get("Location", ""), st)
    c = sql(f"SELECT c.waiver_sha256, c.signature FROM enrollments e JOIN consent_records c ON c.id = e.consent_record_id "
            f"WHERE e.id={e[0]['id']}")
    check("and attached to the existing place", c and c[0]["signature"] == "Pat Adams"
          and c[0]["waiver_sha256"] == hashlib.sha256(WAIVER.encode()).hexdigest(), c)
    st, _, _, html = get(P + "/", cookies=SA)
    check("the prompt is gone", "Action needed" not in html)
    st, h, _, _ = post(P + f"/children/{KID}/waiver/academy",
                       {"waiver_version": "bill-test-v1", "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
                        "photo_release": "yes", "signature": "Pat Adams", "relationship": "Mother"}, cookies=SA)
    check("signing twice does nothing more", len(sql(f"SELECT 1 FROM consent_records WHERE player_id={KID}")) == 1)

    print("\n=== paid without a seat, and access ===")
    sql(f"INSERT INTO enrollments (ref, player_id, household_id, program_id, status, applied_at, created_by, created_at, updated_at) "
        f"SELECT 'ref-brown-000000000000', id, household_id, 'academy', 'waitlist', datetime('now'), 'test', datetime('now'), "
        f"datetime('now') FROM players WHERE id={fams['Brown'][1]}")
    eb = sql(f"SELECT id FROM enrollments WHERE player_id={fams['Brown'][1]}")[0]["id"]
    sql("INSERT INTO audit_log (at, actor, action, subject_type, subject_id) "
        f"VALUES (datetime('now'), 'system:paypal', 'billing.paid_without_seat', 'enrollment', '{eb}')")
    st, _, html = admin("GET", "/billing")
    check("families who paid without a seat are listed for a person to act on",
          "Paid, but no seat to give" in html and "Brown Kid" in html)
    sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
    st, _, _ = admin("GET", "/billing")
    check("a coach cannot open billing", st == 403, st)
    st, h, _ = admin("POST", "/billing/import", {"subscription_id": "I-NOCUSTOM00001"})
    check("or change anything", st == 403, st)
    sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

finally:
    server.shutdown()

check.finish()
