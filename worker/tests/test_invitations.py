"""Invitations to events, and unsubscribing (the Events plan, phase EV5).

Asserted:
- staff choose who (earlier events' sign-ups, CRM contacts by kind) and see a
  count; anyone already signed up, marked do-not-contact or unsubscribed is
  left out, and nobody is invited to the same event twice;
- saving makes a DRAFT: nothing is sent; coaches cannot invite;
- approving queues it; "Send the next 10" sends them (to the local sink only):
  each with a Sign up link carrying its own token, an unsubscribe link, the
  academy's mailing address, and the one-click List-Unsubscribe headers;
- signing up through the link marks the invitation and the sign-up;
- unsubscribing (the page's button, and the mail provider's one-click POST)
  stops every future invitation to that address, logs it on the CRM contact,
  and is harmless to repeat;
- the Outlook copy lists the same people (crm:export, audited by count);
- cancelling stops what is left; the daily brief says when invitations wait
  for approval.
INVITES_ENABLED off, and approval without a mailing address, are proved in
tests/test_events_unit.mjs.
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, Checker, keyed_hash, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"
ORIGIN = "https://tnsaints.com"
EV = "2099-08-01-open-gym"
PAST = "2099-01-10-evaluation"
W = "inv-waiver-v1"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or [], doseq=True).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def api(method, path, body=None, origin=ORIGIN, ip="10.90.0.1", raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if origin:
        req.add_header("Origin", origin)
    req.add_header("CF-Connecting-IP", ip)
    req.add_header("Content-Type", "application/json" if raw is None else "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text.startswith("{") else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        return e.code, (json.loads(text) if text.startswith("{") else text)


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


def reg(event, email, name, status="confirmed"):
    sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, parent_name, "
        "parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, assumption_of_risk, "
        "medical_release, photo_release, signature, signed_at, created_at) VALUES "
        f"('{event}', '6:00 PM', '{status}', lower(hex(randomblob(32))), '{name}', lower('{name}'), '5th', 'Parent {name}', "
        f"'{email}', lower('{email}'), '615', '', 'E', '615', 1, 1, 0, 'P', 'n', 'n')")


# --- setup ----------------------------------------------------------------------------------
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
    f"VALUES ('{W}', 'Saints LLC', 'Waiver', 'text', '{'c' * 64}', 'n', 'n')")
for pid, name, kind, stored, day, status in [(EV, "Open Gym Shoot-Around", "open_gym", "clinic", "2099-08-01", "open"),
                                              (PAST, "Winter Evaluation", "evaluation", "evaluation", "2099-01-10", "closed")]:
    sql("INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, grade_min, grade_max, waiver_version_id, "
        "public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on, location) VALUES "
        f"('{pid}', '{stored}', '{kind}', '{name}', '{status}', 'approval', 'free', 3, 8, '{W}', 1, '2099-07-31T23:59:00.000Z', 1, "
        f"'n', 'n', 'spot', '{day}', 'Grassland Heights gym, Franklin, TN')")
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, starts_on, capacity, status, created_at, updated_at) "
        f"VALUES ('{pid}', '6:00 PM', '6:00 PM', '18:00', '{day}', 30, 'active', 'n', 'n')")
reg(PAST, "ann@example.com", "Ann Kid")
reg(PAST, "bea@example.com", "Bea Kid")
reg(PAST, "cal@example.com", "Cal Kid")
reg(EV, "cal@example.com", "Cal Kid")                       # already signed up for this event: left out
sql("INSERT INTO crm_contacts (kind, name, email, email_norm, source, status, do_not_contact, created_at, updated_at) VALUES "
    "('sponsor', 'Sid Sponsor', 'sid@example.com', 'sid@example.com', 'website:sponsor', 'active', 0, 'n', 'n'), "
    "('family', 'Dana Nope', 'dana@example.com', 'dana@example.com', 'website:general', 'active', 1, 'n', 'n')")
reg(PAST, "dana@example.com", "Dana Kid")                    # do-not-contact: left out
reg(PAST, "gone@example.com", "Gone Kid")                    # unsubscribed earlier: left out
sql(f"INSERT INTO email_suppressions (email_hash, reason, source, created_at) VALUES ('{keyed_hash('email', 'gone@example.com')}', "
    "'unsubscribe', 'test', 'n')")

_captured = []


class _Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        _captured.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        body = b'{"id":"sink"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_srv = ThreadingHTTPServer(("127.0.0.1", 8799), _Sink)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
WHO = [("from_event", PAST), ("crm_kind", "sponsor"), ("crm_kind", "family")]

try:
    print("\n=== choosing who ===")
    st, _, html = admin("GET", f"/events/{EV}/invite")
    check("the invite page offers earlier events and the CRM", st == 200 and "Winter Evaluation" in html and 'value="sponsor"' in html, st)
    st, _, html = admin("GET", f"/events/{EV}/invite?" + urllib.parse.urlencode(WHO))
    check("it counts: two families and a sponsor, everyone else left out", re.search(r"<strong>3 people</strong>", html) is not None
          and "3 left out" in html, re.findall(r"<strong>\d+ (?:people|person)</strong>[^<]*", html))
    role("coach")
    st, _, _ = admin("GET", f"/events/{EV}/invite")
    check("a coach cannot invite", st == 403, st)
    role("admin")

    print("\n=== a draft, sent by nobody ===")
    st, h, _ = admin("POST", f"/events/{EV}/invite", WHO + [("subject", "Come shoot with us"), ("message", "Open gym is back.\n\nBring water.")])
    loc = h.get("Location", "")
    cid = re.search(r"/invites/(\d+)", loc).group(1) if "/invites/" in loc else "0"
    rows = sql(f"SELECT email_norm, send_state FROM event_invitations WHERE campaign_id = {cid} ORDER BY email_norm")
    check("saving makes a draft for exactly those three", st == 303 and "msg=created" in loc
          and [r["email_norm"] for r in rows] == ["ann@example.com", "bea@example.com", "sid@example.com"]
          and all(r["send_state"] == "held" for r in rows), (st, rows))
    check("and nothing is sent", _captured == [], len(_captured))
    st, _, html = admin("GET", f"/events/{EV}/invites/{cid}")
    check("its page shows what it says and that it waits for approval", st == 200 and "Draft — waiting for approval" in html
          and "Open gym is back." in html and "Approve and start sending" in html, st)
    st, _, html = admin("GET", "/brief")
    check("the daily brief says an invitation is waiting for approval", "waiting for approval" in html)
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid}/send")
    time.sleep(0.5)
    check("'Send the next 10' on a draft sends nothing", "msg=not-approved" in h.get("Location", "") and _captured == []
          and {r["send_state"] for r in sql(f"SELECT send_state FROM event_invitations WHERE campaign_id = {cid}")} == {"held"},
          (h.get("Location"), len(_captured)))
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid}/approve".replace(EV, "2099-01-01-other"))
    check("nor can it be approved through another event's address", "msg=invalid" in h.get("Location", ""), h.get("Location"))

    print("\n=== approved, then sent ===")
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid}/approve")
    check("approving queues them", "msg=approved" in h.get("Location", "")
          and {r["send_state"] for r in sql(f"SELECT send_state FROM event_invitations WHERE campaign_id = {cid}")} == {"queued"})
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid}/send")
    time.sleep(0.5)
    sent = [m for m in _captured if m.get("subject") == "Come shoot with us"]
    check("'Send the next 10' sends them, one address each", "msg=sent" in h.get("Location", "") and len(sent) == 3
          and all(len(m.get("to", [])) == 1 for m in sent), len(sent))
    ann = next((m for m in sent if m["to"] == ["ann@example.com"]), {})
    token = sql("SELECT token FROM event_invitations WHERE email_norm = 'ann@example.com'")[0]["token"]
    check("with a Sign up link carrying its own token", f"?event={EV}&amp;inv={token}" in ann.get("html", "")
          or f"?event={EV}&inv={token}" in ann.get("text", ""), ann.get("text", "")[:200])
    check("an unsubscribe link, and the academy's mailing address", f"unsubscribe.html?t={token}" in ann.get("text", "")
          and "Test mailing address, Franklin, TN 37064" in ann.get("text", ""))
    hdr = ann.get("headers", {})
    check("and the one-click unsubscribe headers", f"/api/unsubscribe/one-click?t={token}" in hdr.get("List-Unsubscribe", "")
          and hdr.get("List-Unsubscribe-Post") == "List-Unsubscribe=One-Click", hdr)
    check("greeted by first name, in their own words", "Hi Parent," in ann.get("text", "") and "Bring water." in ann.get("text", ""))
    check("all marked sent", {r["send_state"] for r in sql(f"SELECT send_state FROM event_invitations WHERE campaign_id = {cid}")} == {"sent"})
    before = len(_captured)
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid}/send")
    time.sleep(0.5)
    check("pressing it again sends nobody twice", "msg=none-left" in h.get("Location", "") and len(_captured) == before,
          h.get("Location"))

    print("\n=== signing up from the invitation ===")
    body = {"session_time": "6:00 PM", "player_name": "Ann Kid", "grade": "5th", "parent_name": "Ann Parent",
            "parent_email": "ann@example.com", "phone": "(615) 555-0100", "emergency_contact_name": "Erin Contact",
            "emergency_contact_phone": "(615) 555-0199", "assumption_of_risk": True, "medical_release": True, "photo_release": False,
            "signature": "Ann Parent", "waiver_version_id": W, "turnstile_token": "dummy-token", "invitation": token}
    st, r = api("POST", f"/api/events/{EV}/register", body)
    reg_row = sql(f"SELECT source, invitation_id FROM registrations WHERE event_id = '{EV}' AND parent_email_norm = 'ann@example.com'")
    inv = sql("SELECT id, registered_at FROM event_invitations WHERE email_norm = 'ann@example.com'")
    check("the sign-up says it came from the invitation", st == 200 and reg_row and reg_row[0]["source"] == "invite"
          and reg_row[0]["invitation_id"] == inv[0]["id"] and inv[0]["registered_at"], (st, reg_row, inv))
    st, _, html = admin("GET", f"/events/{EV}/invites/{cid}")
    check("and the invitation's page counts it", re.search(r'<div class="n">1</div><div class="l">Signed up', html) is not None)

    print("\n=== unsubscribing ===")
    btok = sql("SELECT token FROM event_invitations WHERE email_norm = 'bea@example.com'")[0]["token"]
    st, r = api("GET", f"/api/unsubscribe?t={btok}")
    check("the link names the address, masked", st == 200 and r.get("address") == "b•••@example.com" and r.get("already") is False, r)
    st, r = api("POST", "/api/unsubscribe", {"t": btok})
    check("the page's button unsubscribes", st == 200 and r.get("ok") is True
          and sql(f"SELECT reason FROM email_suppressions WHERE email_hash = '{keyed_hash('email', 'bea@example.com')}'")
          == [{"reason": "unsubscribe"}], r)
    st, r = api("POST", "/api/unsubscribe", {"t": btok})
    check("repeating it is harmless", st == 200 and r.get("already") is True, r)
    st, r = api("POST", "/api/unsubscribe", {"t": btok}, origin="https://evil.example")
    check("another website cannot post the button", st == 403, st)
    stok = sql("SELECT token FROM event_invitations WHERE email_norm = 'sid@example.com'")[0]["token"]
    st, r = api("POST", f"/api/unsubscribe/one-click?t={stok}", origin=None, raw=b"List-Unsubscribe=One-Click")
    check("the mail provider's one-click works with no origin", st == 200 and r == "Unsubscribed", (st, r))
    act = sql("SELECT a.kind FROM crm_activities a JOIN crm_contacts c ON c.id = a.contact_id WHERE c.email_norm = 'sid@example.com'")
    check("and it is logged on the CRM contact", {"kind": "unsubscribe"} in act, act)
    st, _ = api("GET", "/api/unsubscribe?t=not-a-real-token-at-all-xx")
    check("a made-up link is not found", st == 404, st)

    print("\n=== never twice, never after unsubscribing ===")
    reg(PAST, "new@example.com", "New Kid")
    st, _, html = admin("GET", f"/events/{EV}/invite?" + urllib.parse.urlencode(WHO))
    check("a second invitation finds only the new family", re.search(r"<strong>1 person</strong>", html) is not None,
          re.findall(r"<strong>\d+ (?:people|person)</strong>", html))
    st, h, _ = admin("POST", f"/events/{EV}/invite", WHO + [("subject", "Last call"), ("message", "A few places left.")])
    cid2 = re.search(r"/invites/(\d+)", h.get("Location", "")).group(1)
    st, _, html = admin("GET", f"/events/{EV}/invites/{cid2}/addresses")
    check("the Outlook copy lists the same people", st == 200 and "new@example.com" in html and "bea@example.com" not in html, st)
    a = sql("SELECT detail FROM audit_log WHERE action = 'event.invite_addresses_copied' ORDER BY id DESC LIMIT 1")
    check("audited by count, never the addresses", a and json.loads(a[0]["detail"]) == {"count": 1}, a)
    role("coach")
    st, _, _ = admin("GET", f"/events/{EV}/invites/{cid2}/addresses")
    check("a coach cannot copy addresses", st == 403, st)
    role("admin")
    st, h, _ = admin("POST", f"/events/{EV}/invites/{cid2}/cancel")
    check("cancelling stops what is left", "msg=cancelled" in h.get("Location", "")
          and sql(f"SELECT send_state FROM event_invitations WHERE campaign_id = {cid2}") == [{"send_state": "cancelled"}])
    check("each step is audited", {"event.invite_drafted", "event.invite_approved", "event.invite_sent", "event.invite_cancelled"}
          <= {x["action"] for x in sql("SELECT action FROM audit_log WHERE action LIKE 'event.invite%'")})
finally:
    _srv.shutdown()

check.finish()
