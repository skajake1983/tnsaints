"""Privacy and safety screens: retention report, legal holds, clearances.

Asserted: "check now" counts without removing anything, whatever the mode;
legal holds need a real record and a reason, are audited without the reason,
and are released once; clearances are validated against the certificate dates,
show current / expiring / expired / missing per person, can be withdrawn, and
lapsing ones reach the daily brief; coaches reach none of it.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, Checker, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = _OPENER.open(req)
    except urllib.error.HTTPError as e:
        r = e
    status = getattr(r, "status", None) or r.code
    headers = {k.lower(): v for k, v in r.headers.items()}
    return status, headers, r.read().decode("utf-8", "replace")


def loc(h):
    return h.get("location", "").replace(A, "", 1)


def one(query):
    rows = sql(query)
    return rows[0] if rows else None


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


for t in ["legal_holds", "clearances", "player_medical", "household_members", "households", "accounts", "registrations",
          "crm_activities", "crm_contacts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM app_settings WHERE key = 'retention.report'")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    "VALUES ('cora@example.com', 'Cora Coach', 'Coach Cora', 'coach', 1, datetime('now'), datetime('now'))")
sql("INSERT INTO households (display_name, created_at, updated_at) VALUES ('The Hold family', 'n', 'n')")
HH = one("SELECT id FROM households WHERE display_name='The Hold family'")["id"]
sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, parent_name, "
    "parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, medical_notes, "
    "assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at) VALUES ('2020-01-11-evaluation', "
    "'9:00 AM', 'confirmed', 'tok-safety', 'Old Eval', 'old eval', '4th', 'P', 'p@example.com', 'p@example.com', '615', 'S', "
    "'EC', '615', 'SAFETY-MEDICAL-CANARY', 1, 1, 1, 'Sig', 'n', '2020-01-01T00:00:00Z')")
REG = one("SELECT id FROM registrations WHERE cancel_token='tok-safety'")["id"]

print("\n=== retention: counts only from the screen ===")
st, _, html = admin("GET", "/privacy")
check("the Privacy page explains retention is report-only", st == 200 and "Report only." in html and "Not checked yet" in html, st)
st, h, _ = admin("POST", "/privacy/retention/check")
check("check now updates the report", "msg=report-run" in loc(h), loc(h))
st, _, html = admin("GET", "/privacy")
check("which shows the old evaluation's medical note as due", "medical notes, 90 days after the evaluation" in html.replace("&#39;", "'"))
check("and removed nothing", one(f"SELECT medical_notes FROM registrations WHERE id={REG}")["medical_notes"] == "SAFETY-MEDICAL-CANARY")
report = json.loads(one("SELECT value FROM app_settings WHERE key='retention.report'")["value"])
check("the saved report holds counts only", "CANARY" not in json.dumps(report)
      and next(r for r in report["rules"] if r["key"] == "medical_eval")["due"] == 1, report)

print("\n=== legal holds ===")
st, h, _ = admin("POST", "/privacy/holds", {"subject_type": "household", "subject_id": "999999", "reason": "Dispute"})
check("a hold on something that does not exist is refused", "msg=hold-not-found" in loc(h), loc(h))
st, h, _ = admin("POST", "/privacy/holds", {"subject_type": "household", "subject_id": str(HH), "reason": "x"})
check("a hold needs a reason", "msg=hold-invalid" in loc(h), loc(h))
st, h, _ = admin("POST", "/privacy/holds", {"subject_type": "nonsense", "subject_id": str(HH), "reason": "Dispute"})
check("and a real kind of record", "msg=hold-invalid" in loc(h), loc(h))
st, h, _ = admin("POST", "/privacy/holds", {"subject_type": "registration", "subject_id": str(REG), "reason": "HOLD-REASON-CANARY claim"})
check("a hold is placed", "msg=hold-placed" in loc(h) and one("SELECT COUNT(*) AS n FROM legal_holds WHERE released_at IS NULL")["n"] == 1, loc(h))
check("and audited without its reason", one("SELECT COUNT(*) AS n FROM audit_log WHERE action='privacy.hold_placed' AND detail NOT LIKE '%CANARY%'")["n"] >= 1
      and one("SELECT COUNT(*) AS n FROM audit_log WHERE detail LIKE '%HOLD-REASON-CANARY%'")["n"] == 0)
st, h, _ = admin("POST", "/privacy/holds", {"subject_type": "registration", "subject_id": str(REG), "reason": "Second"})
check("a second hold on the same record is refused", "msg=hold-exists" in loc(h), loc(h))
admin("POST", "/privacy/retention/check")
report = json.loads(one("SELECT value FROM app_settings WHERE key='retention.report'")["value"])
rule = next(r for r in report["rules"] if r["key"] == "medical_eval")
check("held, the note is no longer due but counted as kept", rule["due"] == 0 and rule["held"] == 1, rule)
st, _, html = admin("GET", "/privacy")
check("the hold is listed with what it holds", "Old Eval" in html and "HOLD-REASON-CANARY claim" in html)
HOLD = one("SELECT id FROM legal_holds")["id"]
st, h, _ = admin("POST", f"/privacy/holds/{HOLD}/release")
check("and released", "msg=hold-released" in loc(h) and one(f"SELECT released_by FROM legal_holds WHERE id={HOLD}")["released_by"] == ME)

print("\n=== clearances ===")
today = sql("SELECT date('now', '-5 hours') AS d")[0]["d"]
st, _, html = admin("GET", "/clearances")
check("everyone who works with children is listed, missing everything", st == 200 and "Cora Coach" in html
      and html.count("Missing") >= 6, st)
st, _, html = admin("POST", "/clearances", {"person_email": "cora@example.com", "person_name": "Cora Coach",
                                            "kind": "background_check", "completed_on": "2099-01-01", "expires_on": ""})
check("a completion date in the future is refused, with the reason", st == 400 and "not in the future" in html, st)
st, _, html = admin("POST", "/clearances", {"person_email": "cora@example.com", "person_name": "Cora Coach",
                                            "kind": "background_check", "completed_on": "2026-01-01", "expires_on": "2025-01-01"})
check("an expiry before completion is refused", st == 400 and "after the completion date" in html, st)
for kind, done, expires in (("background_check", "2025-01-01", "2030-01-01"), ("abuse_prevention", "2025-01-01", ""),
                            ("concussion_training", "2025-01-01", today)):
    st, h, _ = admin("POST", "/clearances", {"person_email": "Cora@Example.com", "person_name": "Cora Coach", "kind": kind,
                                             "completed_on": done, "expires_on": expires, "reference": "REF-123"})
check("records are saved", "msg=recorded" in loc(h) and one("SELECT COUNT(*) AS n FROM clearances WHERE person_email='cora@example.com'")["n"] == 3)
st, _, html = admin("GET", "/clearances")
check("current, no-expiry and expiring-soon show as such", "Current" in html and "no expiry" in html and "Expiring soon" in html)
st, _, html = admin("POST", "/clearances", {"person_email": "vol@example.com", "person_name": "Val Volunteer",
                                            "kind": "background_check", "completed_on": "2020-01-01", "expires_on": "2022-01-01"})
st, _, html = admin("GET", "/clearances")
check("a volunteer with a record appears too, and an old one shows as expired", "Val Volunteer" in html and "Expired" in html)
st, _, html = admin("GET", "/brief")
check("lapsing and lapsed clearances reach the daily brief", "clearance" in html.lower() and "/__admin/clearances" in html)
REC = one("SELECT id FROM clearances WHERE kind='concussion_training'")["id"]
st, h, _ = admin("POST", f"/clearances/{REC}/revoke")
check("a record can be withdrawn", "msg=revoked" in loc(h) and one(f"SELECT revoked_by FROM clearances WHERE id={REC}")["revoked_by"] == ME)
st, h, _ = admin("POST", f"/clearances/{REC}/revoke")
check("but only once", "msg=not-found" in loc(h))
st, _, html = admin("GET", "/clearances/person?email=cora%40example.com")
check("a person's history shows every record, withdrawn ones marked", "(withdrawn)" in html and "REF-123" in html)
check("the audit log has the kind, never the reference number",
      one("SELECT COUNT(*) AS n FROM audit_log WHERE action='clearance.record' AND detail LIKE '%REF-123%'")["n"] == 0
      and one("SELECT COUNT(*) AS n FROM audit_log WHERE action='clearance.record'")["n"] >= 4)

print("\n=== coaches ===")
role("coach")
for method, path in (("GET", "/clearances"), ("POST", "/clearances"), ("GET", "/privacy"), ("POST", "/privacy/holds"),
                     ("POST", "/privacy/retention/check")):
    st, _, _ = admin(method, path, {})
    check(f"a coach is refused {method} {path}", st == 403, st)
role("admin")

check.finish()
