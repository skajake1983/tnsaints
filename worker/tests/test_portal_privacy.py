"""A family's data: download it, and ask for it to be deleted (portal/privacy.js).

Asserted: a download needs a recent sign-in, holds the family's own data (the
child, the medical answer, the signed waiver, parent-facing feedback) and none
of: coaches' staff-only notes, another guardian's email, another family's
anything; it is recorded with counts only.

Deletion (privacy/deletion.js): only the guardian who set up the family can ask
or cancel, with a recent sign-in to ask; it is scheduled once, 7 days out, and
emailed; every guardian sees the date; staff see it (the Privacy queue and the
daily brief), can stop it with a legal hold, and cannot mark it done by hand.
The purge itself is tested against real SQL in tests/test_deletion.mjs.
Requests from before it was automatic still move through their steps by hand;
coaches cannot see the queue.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import (BASE, P, SAME_ORIGIN, Checker, get, make_account, mint_session, post, require_portal,
                     session_cookies, sql)

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()


def export(s):
    req = urllib.request.Request(BASE + P + "/account/export", data=b"", method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in s.items()))
    for k, v in SAME_ORIGIN.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


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
    return (getattr(r, "status", None) or r.code), r.read().decode("utf-8", "replace")


for t in ["data_requests", "payments", "billing_subscriptions", "enrollments", "consent_records", "program_groups",
          "player_medical", "household_emergency_contacts", "household_invites", "household_members", "sessions",
          "account_identities", "rate_limits", "households", "accounts", "eval_notes_internal", "eval_feedback"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM registrations")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

A = make_account("export-a@example.com")
SA = session_cookies(mint_session(A))
post(P + "/family/setup", {"guardian_name": "Ann Export", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=SA)
post(P + "/children", {"child_name": "Ada Export", "date_of_birth": "2016-04-04", "grade": "4", "school": "Export School",
                       "shirt_size": "YM"}, cookies=SA)
KID = sql("SELECT id, household_id FROM players WHERE display_name='Ada Export'")[0]
post(P + f"/children/{KID['id']}/medical", {"medical_status": "declared", "medical_notes": "EXPORT-MED peanut"}, cookies=SA)
post(P + "/contacts", {"ec1_name": "Grandpa Export", "ec1_phone": "(615) 555-0111"}, cookies=SA)
# A co-guardian, and parent-facing feedback plus a staff-only note from a past evaluation.
co = make_account("co-guardian-secret@example.com")
sql(f"INSERT INTO household_members (household_id, account_id, role, created_at) VALUES ({KID['household_id']}, {co}, 'guardian', 'n')")
sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, parent_name, "
    "parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, assumption_of_risk, "
    "medical_release, photo_release, signature, signed_at, created_at, player_id) VALUES ('2026-08-29-evaluation', '9:00 AM', "
    f"'confirmed', 'tok-export', 'Ada Export', 'ada export', '4th', 'Ann', 'export-a@example.com', 'export-a@example.com', "
    f"'615', 'Export School', 'EC', '615', 1, 1, 1, 'Ann', 'n', 'n', {KID['id']})")
reg = sql("SELECT id FROM registrations WHERE cancel_token='tok-export'")[0]["id"]
sql("INSERT INTO eval_feedback (player_id, registration_id, event_id, author_email, author_label, strengths, created_at, updated_at) "
    f"VALUES ({KID['id']}, {reg}, '2026-08-29-evaluation', 'coach@example.com', 'Coach Test', 'PARENT-FACING strong defender', 'n', 'n')")
sql("INSERT INTO eval_notes_internal (player_id, registration_id, event_id, author_email, body, created_at, updated_at) "
    f"VALUES ({KID['id']}, {reg}, '2026-08-29-evaluation', 'coach@example.com', 'STAFF-ONLY-CANARY do not export', 'n', 'n')")
B = make_account("export-b@example.com")
SB = session_cookies(mint_session(B))
post(P + "/family/setup", {"guardian_name": "Bea Other", "phone": "(615) 555-0199", "relationship": "Father"}, cookies=SB)
post(P + "/children", {"child_name": "Other Child", "date_of_birth": "2015-04-04", "grade": "5", "school": "Other School",
                       "shirt_size": "YL"}, cookies=SB)

print("\n=== downloading the family's data ===")
st, _, _, html = get(P + "/account", cookies=SA)
check("the account page offers download and deletion", "Download our data" in html and "Delete our data in 7 days" in html)
stale = session_cookies(mint_session(A, recent=False))
st, _, body = export(stale)
check("a download needs a recent sign-in", st == 403 and "sign in again" in body.lower(), st)
st, h, body = export(SA)
hl = {k.lower(): v for k, v in h.items()}
check("with one, it downloads as a JSON file", st == 200 and "attachment" in hl.get("content-disposition", "")
      and hl.get("content-type", "").startswith("application/json"), (st, hl.get("content-disposition")))
data = json.loads(body) if st == 200 else {}
check("it holds the child, the medical answer and the emergency contact",
      any(c["name"] == "Ada Export" for c in data.get("children", [])) and "EXPORT-MED" in body and "Grandpa Export" in body)
check("and the parent-facing evaluation feedback", "PARENT-FACING strong defender" in body)
check("but never a coach's staff-only note", "STAFF-ONLY-CANARY" not in body)
check("never another guardian's email address", "co-guardian-secret" not in body)
check("and nothing of another family's", "Other Child" not in body and "Bea Other" not in body)
check("the requester's own email is there", data.get("account", {}).get("email") == "export-a@example.com")
dr = sql("SELECT kind, status, result_counts FROM data_requests WHERE kind='export'")
check("the download is recorded, with counts only", dr and dr[0]["status"] == "completed" and "Ada" not in dr[0]["result_counts"]
      and json.loads(dr[0]["result_counts"]).get("children") == 1, dr)
a = sql("SELECT detail FROM audit_log WHERE action='portal.export'")
check("and audited without the data", a and "Ada" not in str(a) and "EXPORT-MED" not in str(a), a)
sql("DELETE FROM rate_limits")
codes = [export(SA)[0] for _ in range(6)]
check("five downloads a day, then 'try tomorrow'", codes[:5] == [200] * 5 and codes[5] == 429, codes)

print("\n=== asking for deletion ===")
import json as _json
import threading as _threading
import time as _time
from http.server import BaseHTTPRequestHandler as _H, ThreadingHTTPServer as _S
_captured = []


class _Sink(_H):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        _captured.append(_json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        body = b'{"id":"sink"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_srv = _S(("127.0.0.1", 8799), _Sink)
_threading.Thread(target=_srv.serve_forever, daemon=True).start()
SCO = session_cookies(mint_session(co))
H = KID["household_id"]
try:
    st, h, _, _ = post(P + "/account/delete-request", {}, cookies=stale)
    check("a deletion request needs a recent sign-in", st == 403 and sql("SELECT 1 FROM data_requests WHERE kind='deletion'") == [], st)
    st, _, _, html = get(P + "/account", cookies=SCO)
    check("a co-guardian is not offered it", "Delete our data in 7 days" not in html
          and "Only the guardian who set up your family can delete its data" in html)
    st, _, _, html = post(P + "/account/delete-request", {}, cookies=SCO)
    check("and is refused if they ask anyway", st == 403 and sql("SELECT 1 FROM data_requests WHERE kind='deletion'") == [], st)
    st, h, _, _ = post(P + "/account/delete-request", {}, cookies=SA)
    check("the owner can ask", st == 303 and "notice=delete-requested" in h.get("Location", ""), st)
    post(P + "/account/delete-request", {}, cookies=SA)
    d = sql("SELECT id, status, subject_id, requested_by, purge_after, "
            "julianday(purge_after) - julianday(created_at) AS days FROM data_requests WHERE kind='deletion'")
    check("asking twice schedules it once, 7 days out", len(d) == 1 and d[0]["status"] == "scheduled"
          and abs(d[0]["days"] - 7) < 0.001 and d[0]["subject_id"] == str(H) and d[0]["requested_by"] == f"account:{A}", d)
    _time.sleep(1)
    mail = [m for m in _captured if "export-a@example.com" in (m.get("to") or [])]
    body = (mail[0].get("text", "") + mail[0].get("html", "")) if mail else ""
    check("and emails the owner the date and how to cancel", len(mail) == 1 and "will be deleted on" in body and "Keep our data" in body
          and "/account" in body, len(mail))
    check("naming no child", "Ada" not in body)
    st, _, _, html = get(P + "/account?notice=delete-requested", cookies=SA)
    check("the owner's Account page says so, with the date and a way to keep the data",
          "emailed you the date" in html and "will be deleted on" in html and "Keep our data" in html)
    st, _, _, html = get(P + "/", cookies=SA)
    check("their family page shows it too", "will be deleted on" in html and "Keep your data" in html)
    st, _, _, html = get(P + "/", cookies=SCO)
    check("so does the co-guardian's, without a way to cancel", "will be deleted on" in html
          and "Only the guardian who set up your family can cancel it" in html and "Keep your data" not in html)
    st, _, _, html = get(P + "/account", cookies=SCO)
    check("nor on their Account page", "will be deleted on" in html and "Keep our data" not in html)
    st, _, _, _ = post(P + "/account/delete-cancel", {}, cookies=SCO)
    check("and a co-guardian who tries is refused", st == 403 and sql(f"SELECT status FROM data_requests WHERE id={d[0]['id']}")[0]["status"] == "scheduled", st)
    st, _, _, html = get(P + "/", cookies=SB)
    check("another family sees nothing of it", "will be deleted on" not in html)
    st, _, _, _ = post(P + "/account/delete-request", {}, cookies=SA, headers={"Sec-Fetch-Site": "cross-site"})
    check("a cross-site request is refused", st == 403, st)

    print("\n=== staff see it, and can stop it ===")
    st, html = admin("GET", "/privacy")
    check("the Privacy queue shows it runs by itself, and how to stop it", st == 200 and "Deletion request" in html
          and "The Export family" in html and "Deletes automatically after" in html and "place a legal hold" in html, st)
    check("with no button to mark it done by hand", f"/privacy/{d[0]['id']}/completed" not in html
          and f"/privacy/{d[0]['id']}/rejected" in html)
    admin("POST", f"/privacy/{d[0]['id']}/completed")
    check("which the server refuses too", sql(f"SELECT status FROM data_requests WHERE id={d[0]['id']}")[0]["status"] == "scheduled")
    st, html = admin("GET", "/brief")
    check("the daily brief says it is coming, and how to stop it", "1 family has asked to delete their data" in html
          and "legal hold" in html)
    _req = urllib.request.Request(BASE + "/__admin/privacy/holds", method="POST", data=urllib.parse.urlencode(
        {"subject_type": "household", "subject_id": str(H), "reason": "Insurance claim"}).encode())
    _req.add_header("Content-Type", "application/x-www-form-urlencoded")
    _req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        urllib.request.build_opener(_NoRedirect).open(_req)
    except urllib.error.HTTPError:
        pass
    st, html = admin("GET", "/privacy")
    check("a legal hold on the family shows it will not run", "On legal hold" in html)
    sql("UPDATE legal_holds SET released_at = 'x', released_by = 'test'")

    print("\n=== changing your mind ===")
    st, h, _, _ = post(P + "/account/delete-cancel", {}, cookies=stale)
    check("the owner cancels, even without a recent sign-in", st == 303 and "notice=delete-cancelled" in h.get("Location", ""), st)
    r = sql(f"SELECT status, completed_by FROM data_requests WHERE id={d[0]['id']}")
    check("the request is cancelled, by whom recorded", r == [{"status": "cancelled", "completed_by": f"account:{A}"}], r)
    st, _, _, html = get(P + "/", cookies=SCO)
    check("and every guardian's page stops saying so", "will be deleted on" not in html)
    check("both are audited", {"portal.deletion_requested", "portal.deletion_cancelled"}
          <= {x["action"] for x in sql("SELECT action FROM audit_log WHERE action LIKE 'portal.deletion%'")})
    sql("DELETE FROM rate_limits")
    codes = [post(P + "/account/delete-request", {}, cookies=SA)[0] for _ in range(4)]
    check("asking is limited to 3 times a day (each one emails)", codes[:3] == [303] * 3 and codes[3] == 429, codes)
finally:
    _srv.shutdown()

print("\n=== requests from before deletion was automatic ===")
sql("DELETE FROM data_requests WHERE kind='deletion'")
sql("INSERT INTO data_requests (kind, subject_type, subject_id, requested_by, status, verification, created_at, updated_at) "
    f"VALUES ('deletion', 'household', '{H}', 'account:{A}', 'received', 'recent_sign_in', 'n', 'n')")
rid = sql("SELECT id FROM data_requests WHERE kind='deletion'")[0]["id"]
st, _ = admin("POST", f"/privacy/{rid}/completed")
check("it cannot skip straight from received to completed", sql(f"SELECT status FROM data_requests WHERE id={rid}")[0]["status"] == "received")
admin("POST", f"/privacy/{rid}/verified")
admin("POST", f"/privacy/{rid}/completed")
r = sql(f"SELECT status, completed_by FROM data_requests WHERE id={rid}")
check("verified, then completed, by whom", r == [{"status": "completed", "completed_by": ME}], r)
check("each step is audited", {"privacy.verified", "privacy.completed"} <= {x["action"] for x in sql("SELECT action FROM audit_log WHERE action LIKE 'privacy.%'")})
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _ = admin("GET", "/privacy")
check("a coach cannot open the Privacy queue", st == 403, st)
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

check.finish()
