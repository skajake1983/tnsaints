"""The daily staff brief (jobs/brief.js): one email a day, only when there is something to do.

Asserted: an empty day sends nothing; a busy day lists what needs a person,
each line linking to where to act; the email names no child and costs one
credit in the alert lane; the scheduled send is off unless STAFF_BRIEF_ENABLED
is exactly "true"; only admins can preview or send it.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, WORKER_DIR, Checker, sql

preflight(BASE)
check = Checker()
ME = staff_email()
captured = []


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        captured.append(json.loads(raw))
        body = json.dumps({"id": f"sink-{len(captured)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path):
    req = urllib.request.Request(BASE + "/__admin" + path, data=b"" if method == "POST" else None, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def msg(h):
    return urllib.parse.parse_qs(urllib.parse.urlparse(h.get("Location", "")).query).get("msg", [None])[0]


server = ThreadingHTTPServer(("127.0.0.1", 8799), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    for t in ["crm_tasks", "crm_opportunities", "crm_inquiries", "crm_prospect_players", "crm_contacts", "payments",
              "billing_subscriptions", "enrollments", "email_budget"]:
        sql(f"DELETE FROM {t}")
    sql("DELETE FROM audit_log WHERE action = 'billing.paid_without_seat'")
    sql("DELETE FROM staff")
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    print("\n=== a quiet day ===")
    st, _, html = admin("GET", "/brief")
    check("the preview says there is nothing to report", st == 200 and "Nothing to report today" in html, st)
    st, h, _ = admin("POST", "/brief/send")
    time.sleep(0.5)
    check("and sending sends nothing", msg(h) == "empty" and captured == [], (msg(h), len(captured)))

    print("\n=== a busy day ===")
    sql("INSERT INTO crm_contacts (kind, name, email, email_norm, source, created_at, updated_at) VALUES "
        "('family', 'Pat Parent', 'pat@example.com', 'pat@example.com', 'website:player', datetime('now'), datetime('now'))")
    cid = sql("SELECT id FROM crm_contacts")[0]["id"]
    sql("INSERT INTO crm_inquiries (contact_id, purpose, fields, received_at) VALUES "
        f"({cid}, 'player', '{{}}', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    sql("INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at) "
        "VALUES ('Brief Kid', 'brief kid', 'brief@example.com', 'n', 'n')")
    pid = sql("SELECT id FROM players WHERE name_norm='brief kid'")[0]["id"]
    sql("INSERT INTO households (display_name, created_at, updated_at) VALUES ('The Brief family', 'n', 'n')")
    hid = sql("SELECT id FROM households WHERE display_name='The Brief family'")[0]["id"]
    sql("INSERT INTO enrollments (ref, player_id, household_id, program_id, status, applied_at, created_by, created_at, updated_at) "
        f"VALUES ('ref-brief-00000000000', {pid}, {hid}, 'academy', 'applied', 'n', 'test', 'n', 'n')")
    sql("INSERT INTO billing_subscriptions (paypal_subscription_id, environment, status, source, created_at, updated_at) "
        "VALUES ('I-BRIEFUNLINKED1', 'sandbox', 'ACTIVE', 'joinpage', 'n', 'n')")
    st, _, html = admin("GET", "/brief")
    check("the preview lists what needs a person",
          "1 new academy application to review" in html and "1 website inquiry in the last day (1 not yet handled)" in html
          and "1 PayPal subscription not yet matched to a child" in html, html[-600:])
    check("each line links to where to act", '/__admin/enrollments"' in html and '/__admin/inbox"' in html and '/__admin/billing"' in html)
    check("and says the daily send is off until switched on", "STAFF_BRIEF_ENABLED" in html)
    captured.clear()
    st, h, _ = admin("POST", "/brief/send")
    time.sleep(1)
    check("sending it now sends one email", msg(h) == "sent" and len(captured) == 1, (msg(h), len(captured)))
    m = captured[0] if captured else {}
    body = m.get("text", "") + m.get("html", "")
    check("to the staff mailbox", m.get("to") == ["info@tnsaints.com"], m.get("to"))
    check("with the admin links", "https://admin.tnsaints.com/enrollments" in body and "https://admin.tnsaints.com/billing" in body)
    check("naming no child", "Brief Kid" not in body and "Pat Parent" not in body)
    check("costing one credit", sql("SELECT COALESCE(SUM(sent),0) AS n FROM email_budget")[0]["n"] == 1)
    check("and the send is audited", sql("SELECT 1 FROM audit_log WHERE action='brief.send'") != [])

    sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
    st, _, _ = admin("GET", "/brief")
    check("a coach cannot preview it", st == 403, st)
    st, _, _ = admin("POST", "/brief/send")
    check("or send it", st == 403, st)
    sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")
finally:
    server.shutdown()

print("\n=== the rules (imported directly) ===")
UNIT = r"""
import { briefLines, runStaffBrief } from './src/jobs/brief.js';
let called = false;
const off = await runStaffBrief({ STAFF_BRIEF_ENABLED: 'True' }, async () => { called = true; return { ok: true }; });
const zero = { newInquiries: 0, unhandledInquiries: 0, tasksDue: 0, applied: 0, waitlist: 0, offersLapsingSoon: 0,
               pastDue: 0, unlinkedSubscriptions: 0, paidWithoutSeat: 0 };
console.log(JSON.stringify({
  off, called,
  empty: briefLines(zero).length,
  urgentFirst: briefLines({ ...zero, applied: 2, paidWithoutSeat: 1 }).map((l) => l.path),
  plural: briefLines({ ...zero, applied: 2 })[0].text,
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-300:])
if u:
    check("the scheduled send is off unless STAFF_BRIEF_ENABLED is exactly 'true', and then sends nothing",
          u["off"] == {"sent": False, "reason": "disabled"} and u["called"] is False, u)
    check("a day with nothing in it has no lines", u["empty"] == 0)
    check("money problems come first", u["urgentFirst"] == ["/billing", "/enrollments"], u["urgentFirst"])
    check("plurals read naturally", u["plural"] == "2 new academy applications to review", u["plural"])

check.finish()
