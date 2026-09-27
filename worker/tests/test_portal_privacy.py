"""A family's data: download it, and ask for it to be deleted (portal/privacy.js).

Asserted: a download needs a recent sign-in, holds the family's own data (the
child, the medical answer, the signed waiver, parent-facing feedback) and none
of: coaches' staff-only notes, another guardian's email, another family's
anything; it is recorded with counts only. A deletion request is recorded once,
reaches staff (the Privacy queue and the daily brief) and moves through its
steps there; coaches cannot see the queue.
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
check("the account page offers download and deletion", "Download our data" in html and "Ask us to delete our data" in html)
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
st, h, _, _ = post(P + "/account/delete-request", {}, cookies=stale)
check("a deletion request needs a recent sign-in", st == 403 and sql("SELECT 1 FROM data_requests WHERE kind='deletion'") == [], st)
st, h, _, _ = post(P + "/account/delete-request", {}, cookies=SA)
check("with one, it is received", st == 303 and "notice=delete-requested" in h.get("Location", ""), st)
post(P + "/account/delete-request", {}, cookies=SA)
d = sql("SELECT id, status, subject_id, requested_by FROM data_requests WHERE kind='deletion'")
check("asking twice records one request", len(d) == 1 and d[0]["status"] == "received"
      and d[0]["subject_id"] == str(KID["household_id"]) and d[0]["requested_by"] == f"account:{A}", d)
st, _, _, html = get(P + "/account?notice=delete-requested", cookies=SA)
# The page escapes the apostrophe in "We'll", so match the words after it.
check("the family is told what happens next", "email you to confirm" in html)
st, _, _, _ = post(P + "/account/delete-request", {}, cookies=SA, headers={"Sec-Fetch-Site": "cross-site"})
check("a cross-site request is refused", st == 403, st)

print("\n=== staff act on it ===")
st, html = admin("GET", "/privacy")
check("the Privacy queue shows the request and the steps", st == 200 and "Deletion request" in html
      and "The Export family" in html and "Keep signed waivers" in html, st)
st, html = admin("GET", "/brief")
check("the daily brief counts it", "1 data deletion request is waiting" in html)
rid = d[0]["id"]
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
