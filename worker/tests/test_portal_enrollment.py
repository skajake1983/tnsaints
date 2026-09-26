"""Apply -> offer a seat -> pay-by -> waitlist (src/programs/enrollment.js).

The owner's rule, asserted end to end: nobody pays without a seat in a
scheduled group. Families apply (signing the waiver); staff offer a seat in a
group only while it has room, atomically; the offer carries a pay-by date; a
lapsed offer frees its seat at once. Capacity is counted, never stored.

The academy is opened here with a TEST price and a TEST waiver, in the local
database only. Its real price (O5), groups (O8) and waiver text (O9) are the
owner's to supply.
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import (BASE, P, Checker, get, make_account, mint_session, post, require_portal,
                     session_cookies, sql)

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()
ADMIN = "/__admin"
captured = []


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            captured.append(json.loads(raw))
        except json.JSONDecodeError:
            captured.append({})
        body = json.dumps({"id": f"sink-{len(captured)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def admin(method, path, fields=None):
    """Admin calls through the local door, as a browser form would, not following redirects."""
    import urllib.parse
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + ADMIN + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        r = urllib.request.build_opener(NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def status_of(enrollment_id):
    rows = sql(f"SELECT status, group_id, offer_expires_at, waitlisted_at FROM enrollments WHERE id={enrollment_id}")
    return rows[0] if rows else None


# One line: it reaches SQLite through a shell argument, and cmd.exe mangles newlines.
WAIVER = ("TEST WAIVER - NOT FOR USE. I understand that basketball involves physical contact and a risk of injury. "
          "I authorise emergency medical treatment for my child if I cannot be reached.")
SHA = hashlib.sha256(WAIVER.encode()).hexdigest()


def family(email, name, child, grade="4"):
    acc = make_account(email)
    s = session_cookies(mint_session(acc))
    post(P + "/family/setup", {"guardian_name": f"{name} Parent", "phone": "(615) 555-0100", "relationship": "Mother"}, cookies=s)
    post(P + "/children", {"child_name": child, "date_of_birth": "2016-04-04", "grade": grade,
                           "school": "Test School", "shirt_size": "YM"}, cookies=s)
    kid = sql(f"SELECT id FROM players WHERE display_name='{child}'")[0]["id"]
    post(P + f"/children/{kid}/medical", {"medical_status": "none_declared"}, cookies=s)
    post(P + "/contacts", {"ec1_name": f"{name} Contact", "ec1_phone": "(615) 555-0199"}, cookies=s)
    return acc, s, kid


def apply(s, kid, **over):
    fields = {"waiver_version": "test-academy-v1", "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
              "photo_release": "no", "signature": "Signing Parent", "relationship": "Mother", "groups": [str(TUE)]}
    fields.update(over)
    return post(P + f"/children/{kid}/apply/academy", {k: v for k, v in fields.items() if v is not None}, cookies=s)


server = ThreadingHTTPServer(("127.0.0.1", 8799), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    for t in ["enrollments", "consent_records", "program_groups", "player_medical", "household_emergency_contacts",
              "household_invites", "household_members", "sessions", "account_identities", "households", "accounts",
              "email_budget", "rate_limits"]:
        sql(f"DELETE FROM {t}")
    sql("DELETE FROM players WHERE household_id IS NOT NULL")
    sql("UPDATE programs SET status='draft', waiver_version_id=NULL, price_cents=NULL WHERE id='academy'")
    sql("DELETE FROM waiver_versions")
    sql("DELETE FROM staff")
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    A, SA, KID_A = family("alpha@example.com", "Alpha", "Alpha Kid")
    B, SB, KID_B = family("bravo@example.com", "Bravo", "Bravo Kid")
    C, SC, KID_C = family("charlie@example.com", "Charlie", "Charlie Kid")

    print("\n=== while the academy is a draft ===")
    st, _, _, html = get(P + f"/children/{KID_A}/apply/academy", cookies=SA)
    check("nobody can apply", st == 200 and "aren't open right now" in html, st)

    # Open it with a TEST waiver and price, in the local database only.
    sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
        f"('test-academy-v1', 'Tennessee Saints (test)', 'Academy participation waiver (TEST)', '{WAIVER}', '{SHA}', "
        "datetime('now'), datetime('now'))")
    sql("UPDATE programs SET status='open', price_cents=15000, waiver_version_id='test-academy-v1' WHERE id='academy'")
    for name, schedule, day, cap in (("Tuesday group", "Tuesdays 6:00-7:30 PM", 2, 2),
                                     ("Thursday group", "Thursdays 6:00-7:30 PM", 4, 1)):
        sql("INSERT INTO program_groups (program_id, name, schedule_summary, weekday, location, starts_on, capacity, "
            f"created_at, updated_at) VALUES ('academy', '{name}', '{schedule}', {day}, 'Test Gym', "
            f"'2026-10-06', {cap}, datetime('now'), datetime('now'))")
    TUE = sql("SELECT id FROM program_groups WHERE name='Tuesday group'")[0]["id"]
    THU = sql("SELECT id FROM program_groups WHERE name='Thursday group'")[0]["id"]

    print("\n=== the application page ===")
    st, _, _, html = get(P + f"/children/{KID_A}/apply/academy", cookies=SA)
    check("it opens for a child with a complete profile", st == 200 and "Sign and apply" in html, st)
    check("it states the price in words, and that nothing is paid until a place is offered",
          "$150 a month, plus a one-time $40 setup fee" in html and "only once we offer" in html)
    check("it shows each group's schedule", "Tuesdays 6:00-7:30 PM" in html and "Thursdays 6:00-7:30 PM" in html)
    check("it shows the whole waiver text and who it is with",
          "physical contact and a risk of injury" in html and "Tennessee Saints (test)" in html)
    check("photo release is a real choice", 'name="photo_release" value="yes"' in html and 'value="no"' in html)

    sql(f"DELETE FROM player_medical WHERE player_id={KID_C}")
    st, _, _, html = get(P + f"/children/{KID_C}/apply/academy", cookies=SC)
    check("an incomplete profile lists exactly what is missing, with no form",
          "Answer the medical question" in html and "Sign and apply" not in html)
    post(P + f"/children/{KID_C}/medical", {"medical_status": "none_declared"}, cookies=SC)
    old = family("delta@example.com", "Delta", "Delta Kid", grade="8")
    st, _, _, html = get(P + f"/children/{old[2]}/apply/academy", cookies=old[1])
    check("a child outside grades 3-6 cannot apply", "grades 3" in html and "Sign and apply" not in html)

    print("\n=== applying ===")
    st, _, _, html = apply(SA, KID_A, agree_risk=None, agree_esign=None, photo_release="", signature="")
    check("missing agreements, photo answer and signature are each reported",
          st == 400 and all(f'href="#{f}"' in html for f in ("agree_risk", "agree_esign", "photo_release", "signature")), st)
    st, _, _, html = apply(SA, KID_A, waiver_version="an-older-waiver")
    check("a signature against a waiver that is no longer current is refused", st == 409 and "updated" in html, st)
    check("and nothing was recorded", sql("SELECT 1 FROM consent_records") == [] and sql("SELECT 1 FROM enrollments") == [])
    st, h, _, _ = apply(SA, KID_A, groups=[str(TUE), str(THU)], photo_release="yes")
    check("a complete application is accepted", st == 303 and "notice=applied" in h.get("Location", ""), st)
    c = sql(f"SELECT waiver_version_id, waiver_sha256, signature, signer_relationship, photo_release, account_id "
            f"FROM consent_records WHERE player_id={KID_A}")
    check("the signed waiver is recorded against its exact text",
          c and c[0]["waiver_sha256"] == SHA and c[0]["signature"] == "Signing Parent" and c[0]["photo_release"] == 1
          and c[0]["account_id"] == A, c)
    e = sql(f"SELECT id, status, consent_record_id, preferred_group_ids, ref FROM enrollments WHERE player_id={KID_A}")
    check("and the application points at that consent", e and e[0]["status"] == "applied"
          and e[0]["consent_record_id"] is not None and json.loads(e[0]["preferred_group_ids"]) == [TUE, THU], e)
    check("with an unguessable reference (what PayPal will be sent)", e and len(e[0]["ref"]) >= 22 and "Alpha" not in e[0]["ref"])
    EA = e[0]["id"] if e else None
    st, _, _, html = apply(SA, KID_A)
    check("applying twice for the same child is refused", st == 409 and "already has an" in html, st)
    check("and made no second consent", len(sql(f"SELECT 1 FROM consent_records WHERE player_id={KID_A}")) == 1)
    st, _, _, html = get(P + "/?notice=applied", cookies=SA)
    check("the family page confirms it", "Application received" in html)
    st, _, _, _ = get(P + f"/children/{KID_A}/apply/academy", cookies=SB)
    check("another family cannot even open this child's application", st == 404, st)
    apply(SB, KID_B)
    apply(SC, KID_C, groups=[str(THU)])
    EB = sql(f"SELECT id FROM enrollments WHERE player_id={KID_B}")[0]["id"]
    EC = sql(f"SELECT id FROM enrollments WHERE player_id={KID_C}")[0]["id"]

    print("\n=== the staff queue ===")
    st, _, html = admin("GET", "/enrollments")
    check("staff see every request in line order", st == 200 and all(k in html for k in ("Alpha Kid", "Bravo Kid", "Charlie Kid")), st)
    check("with seats per group", "0 / 2" in html and "0 / 1" in html)
    check("and the waiting demand", "3 waiting for a seat" in html)

    print("\n=== offering seats ===")
    captured.clear()
    st, h, _ = admin("POST", f"/enrollments/{EA}/offer", {"group_id": str(THU)})
    check("offering the Thursday seat to Alpha succeeds", st == 303 and "msg=offered" in h.get("Location", ""), h.get("Location"))
    s = status_of(EA)
    check("the request is now 'offered' in that group, with a pay-by date", s and s["status"] == "offered" and s["group_id"] == THU
          and s["offer_expires_at"], s)
    time.sleep(1)
    mail = [m for m in captured if "alpha@example.com" in (m.get("to") or [])]
    check("the family is emailed the place, schedule and pay-by date", mail and "Thursdays 6:00-7:30 PM" in mail[0].get("text", "")
          and "Complete by" in mail[0].get("text", ""), [m.get("subject") for m in captured])
    check("the email names no child", mail and "Alpha Kid" not in (mail[0].get("text", "") + mail[0].get("html", "")))
    st, h, _ = admin("POST", f"/enrollments/{EC}/offer", {"group_id": str(THU)})
    check("the Thursday group is now full: a second offer is refused", "msg=full" in h.get("Location", "")
          and status_of(EC)["status"] == "applied", h.get("Location"))
    st, _, _, html = get(P + "/", cookies=SA)
    check("the family page shows the offer and its deadline", "Place offered" in html and "Thursday group" in html)

    print("\n=== the last seat, twice at once ===")
    sql(f"UPDATE program_groups SET capacity=1 WHERE id={TUE}")
    results = []

    def race(eid):
        results.append(admin("POST", f"/enrollments/{eid}/offer", {"group_id": str(TUE)})[1].get("Location", ""))
    threads = [threading.Thread(target=race, args=(eid,)) for eid in (EB, EC)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    offered = [eid for eid in (EB, EC) if status_of(eid)["status"] == "offered"]
    check("exactly one of two simultaneous offers for the last seat wins", len(offered) == 1, (results, offered))
    held = sql(f"SELECT COUNT(*) AS n FROM enrollments WHERE group_id={TUE} AND status='offered'")[0]["n"]
    check("so the group is never over capacity", held == 1, held)
    LOSER = EC if offered == [EB] else EB

    print("\n=== an offer that lapses gives its seat back ===")
    sql(f"UPDATE enrollments SET offer_expires_at='2000-01-01T00:00:00.000Z' WHERE id={EA}")
    st, h, _ = admin("POST", f"/enrollments/{EC if LOSER == EC else EB}/offer", {"group_id": str(THU)})
    check("the moment an offer lapses, its seat can be offered to the next family", "msg=offered" in h.get("Location", ""),
          h.get("Location"))
    admin("GET", "/enrollments")
    s = status_of(EA)
    check("and the lapsed request is back on the waiting list, keeping its place",
          s["status"] == "waitlist" and s["group_id"] is None and s["waitlisted_at"], s)

    print("\n=== waiting list and decline ===")
    other = EB if LOSER == EC else EC
    st, h, _ = admin("POST", f"/enrollments/{other}/waitlist")
    check("an offer can be withdrawn to the waiting list", "msg=waitlisted" in h.get("Location", "")
          and status_of(other)["status"] == "waitlist")
    st, h, _ = admin("POST", f"/enrollments/{EA}/decline", {"reason": "not-a-reason"})
    check("a decline needs a listed reason", "msg=state" in h.get("Location", "") and status_of(EA)["status"] == "waitlist")
    st, h, _ = admin("POST", f"/enrollments/{EA}/decline", {"reason": "space"})
    check("a decline with a reason is recorded", "msg=declined" in h.get("Location", "") and status_of(EA)["status"] == "declined")
    st, h, _, _ = apply(SA, KID_A)
    check("once declined, the family may apply again later", st == 303, st)
    audit = sql("SELECT action, subject_type, detail FROM audit_log WHERE action LIKE 'enrollment.%'")
    check("every staff decision is audited by id", {"enrollment.offer", "enrollment.waitlist", "enrollment.decline"}
          <= {a["action"] for a in audit} and "Kid" not in json.dumps(audit), audit)

    print("\n=== only admins decide ===")
    sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
    st, _, _ = admin("GET", "/enrollments")
    check("a coach cannot open the queue", st == 403, st)
    st, _, _ = admin("POST", f"/enrollments/{EB}/offer", {"group_id": str(TUE)})
    check("or offer a seat", st == 403, st)
    sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

finally:
    server.shutdown()

check.finish()
