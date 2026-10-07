"""The CRM screens (admin/routes/crm.js, crm/store.js), through the dev server.

Asserted: only academy admins reach the CRM (coaches get 403 on every
screen); cards move only to stages of their own pipeline, and the timeline
records who moved them; forms can only send you back to CRM pages; the CSV is
formula-safe, admin-only and audited; contacts added by hand are validated and
never duplicated; calls and notes land on the timeline and never in the audit
log; linking a lead to its portal family converts it; tasks move between
views; customers are read live; merge and anonymize do what they say and are
audited; the evaluation import is idempotent.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, Checker, make_account, sql

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


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


def one(query):
    rows = sql(query)
    return rows[0] if rows else None


for t in ["crm_activities", "crm_household_meta", "crm_tasks", "crm_opportunities", "crm_inquiries", "crm_prospect_players",
          "crm_contacts", "payments", "billing_subscriptions", "enrollments", "consent_records", "program_groups",
          "household_members", "sessions", "account_identities", "households", "accounts", "eval_feedback",
          "eval_notes_internal", "parent_messages", "decisions"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players")
sql("DELETE FROM registrations")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    "VALUES ('mike@example.com', 'Mike Owner', 'Coach Mike', 'admin', 1, datetime('now'), datetime('now'))")

# A website lead: a family wanting the academy for one child, with an inquiry and an auto task.
sql("INSERT INTO crm_contacts (kind, name, email, email_norm, phone, phone_norm, source, created_at, updated_at) VALUES "
    "('family', 'Lena Lead', 'lena@example.com', 'lena@example.com', '(615) 555-0101', '6155550101', 'website:player', "
    "'2026-10-01T15:00:00Z', '2026-10-01T15:00:00Z')")
LENA = one("SELECT id FROM crm_contacts WHERE email_norm='lena@example.com'")["id"]
sql(f"INSERT INTO crm_prospect_players (contact_id, name, created_at, updated_at) VALUES ({LENA}, 'Lily Lead', 'n', 'n')")
PP = one("SELECT id FROM crm_prospect_players")["id"]
sql("INSERT INTO crm_opportunities (pipeline, stage, contact_id, prospect_player_id, source, opened_at, created_at, updated_at) "
    f"VALUES ('family', 'new', {LENA}, {PP}, 'website:player', 'n', 'n', 'n')")
CARD = one("SELECT id FROM crm_opportunities")["id"]
sql("INSERT INTO crm_inquiries (contact_id, purpose, fields, message, received_at) VALUES "
    f"({LENA}, 'player', '{{\"player_name\":\"Lily Lead\",\"grade\":\"4th\"}}', 'Does Lily need to try out?', '2026-10-01T15:00:00Z')")

print("\n=== only academy admins ===")
role("coach")
for path in ["/crm", "/crm/list", "/crm/tasks", "/crm/customers", f"/crm/contacts/{LENA}", "/crm/contacts/new", "/crm/import",
             "/crm/list.csv"]:
    st, _, _ = admin("GET", path)
    check(f"a coach is refused {path}", st == 403, st)
st, _, _ = admin("POST", f"/crm/cards/{CARD}/move", {"stage": "contacted"})
check("and cannot move a card", st == 403 and one(f"SELECT stage FROM crm_opportunities WHERE id={CARD}")["stage"] == "new", st)
role("admin")

print("\n=== the pipeline board ===")
st, _, html = admin("GET", "/crm")
check("the family board shows the child's card in New", st == 200 and "Lily Lead" in html and "Lena Lead" in html, st)
check("with a labelled Move control for keyboard use", f'for="mv{CARD}"' in html and "Move Lily Lead to" in html)
st, h, _ = admin("POST", f"/crm/cards/{CARD}/move", {"stage": "contacted", "back": "/crm?pipeline=family"})
check("moving a card goes back to the board", st == 303 and loc(h).startswith("/crm?pipeline=family") and "msg=moved" in loc(h), loc(h))
check("and moves it", one(f"SELECT stage FROM crm_opportunities WHERE id={CARD}")["stage"] == "contacted")
a = one(f"SELECT kind, actor, json_extract(detail, '$.from') AS f, json_extract(detail, '$.to') AS t FROM crm_activities WHERE opportunity_id={CARD}")
check("the timeline records who moved it from where to where", a == {"kind": "stage", "actor": ME, "f": "new", "t": "contacted"}, a)
st, h, _ = admin("POST", f"/crm/cards/{CARD}/move", {"stage": "proposal"})
check("a stage from another pipeline is refused", "msg=invalid" in loc(h)
      and one(f"SELECT stage FROM crm_opportunities WHERE id={CARD}")["stage"] == "contacted", loc(h))
st, h, _ = admin("POST", f"/crm/cards/{CARD}/move", {"stage": "contacted", "back": "https://evil.example/steal"})
check("a form can only send you back to a CRM page", loc(h).startswith("/crm?msg=") and "evil" not in h.get("location", ""), loc(h))
st, _, html = admin("GET", "/crm?pipeline=sponsor")
check("other pipelines have their own board", st == 200 and "Proposal sent" in html, st)

print("\n=== contacts: list, CSV, add ===")
st, _, html = admin("GET", "/crm/list?q=lena")
check("search finds the lead", st == 200 and "Lena Lead" in html and "lena@example.com" in html, st)
st, _, html = admin("GET", "/crm/list?q=nobody-matches")
check("and finds nothing when nothing matches", "No contacts match" in html)
st, h, html = admin("POST", "/crm/contacts/new", {"kind": "family", "name": "", "email": "bad", "phone": ""})
check("a contact without a name or a real email is refused, with reasons", st == 400 and "Enter a name." in html
      and "valid email" in html and 'aria-invalid="true"' in html, st)
st, h, _ = admin("POST", "/crm/contacts/new", {"kind": "family", "name": "=HYPERLINK(\"http://x\")", "email": "formula@example.com",
                                               "child_name": "Finn Formula", "child_grade": "5th", "owner": "mike@example.com"})
FORMULA = one("SELECT id FROM crm_contacts WHERE email_norm='formula@example.com'")
check("a valid family contact is added, with a card for the child", st == 303 and FORMULA and "msg=created" in loc(h)
      and one(f"SELECT COUNT(*) AS n FROM crm_opportunities o JOIN crm_prospect_players p ON p.id = o.prospect_player_id "
              f"WHERE o.contact_id={FORMULA['id']} AND p.name='Finn Formula' AND o.owner_email='mike@example.com'")["n"] == 1, loc(h))
st, h, _ = admin("POST", "/crm/contacts/new", {"kind": "sponsor", "name": "Again", "email": "FORMULA@example.com"})
check("the same email again leads to the existing contact, not a second one",
      f"/crm/contacts/{FORMULA['id']}?msg=exists" == loc(h)
      and one("SELECT COUNT(*) AS n FROM crm_contacts WHERE email_norm='formula@example.com'")["n"] == 1, loc(h))
st, h, csv = admin("GET", "/crm/list.csv")
check("the CSV downloads as an attachment", st == 200 and h.get("content-type", "").startswith("text/csv")
      and "attachment" in h.get("content-disposition", ""), st)
check("and is formula-safe", "'=HYPERLINK" in csv and "\n=HYPERLINK" not in csv)
check("the download is audited with counts, not contents",
      (lambda r: r and "Lena" not in r["detail"] and json.loads(r["detail"])["rows"] == 2)(
          one("SELECT detail FROM audit_log WHERE action='crm.export' ORDER BY id DESC LIMIT 1")))

print("\n=== one contact ===")
st, _, html = admin("GET", f"/crm/contacts/{LENA}")
check("the contact page shows details, the child, the card and the website inquiry",
      st == 200 and "Lena Lead" in html and "Lily Lead" in html and "Does Lily need to try out?" in html, st)
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/activity", {"kind": "call", "body": "STAFF-NOTE-CANARY spoke with Lena",
                                                           "occurred_on": "", "back": f"/crm/contacts/{LENA}"})
check("a call is logged", "msg=logged" in loc(h) and one(f"SELECT COUNT(*) AS n FROM crm_activities WHERE contact_id={LENA} AND kind='call'")["n"] == 1, loc(h))
st, _, html = admin("GET", f"/crm/contacts/{LENA}")
check("and appears on the timeline", "STAFF-NOTE-CANARY" in html)
check("staff notes never reach the audit log", one("SELECT COUNT(*) AS n FROM audit_log WHERE detail LIKE '%STAFF-NOTE-CANARY%'")["n"] == 0)
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/activity", {"kind": "note", "body": "", "back": f"/crm/contacts/{LENA}"})
check("an empty note is refused", "msg=invalid" in loc(h))
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/activity", {"kind": "call", "occurred_on": "2099-01-01"})
check("a call dated in the future is refused", "msg=invalid" in loc(h))
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/owner", {"owner": "mike@example.com"})
check("an owner can be set, and the open card follows", "msg=saved" in loc(h)
      and one(f"SELECT owner_email FROM crm_opportunities WHERE id={CARD}")["owner_email"] == "mike@example.com", loc(h))
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/owner", {"owner": "stranger@example.com"})
check("but only to someone on staff", "msg=invalid" in loc(h))
dnc_before = one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.dnc'")["n"]
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/dnc", {"on": "1"})
st, _, html = admin("GET", f"/crm/contacts/{LENA}")
check("do not contact shows on the page, the timeline and the audit log", "Do not contact" in html
      and one(f"SELECT COUNT(*) AS n FROM crm_activities WHERE contact_id={LENA} AND kind='dnc'")["n"] == 1
      and one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.dnc'")["n"] == dnc_before + 1)

print("\n=== tasks ===")
today = sql("SELECT date('now', '-5 hours') AS d")[0]["d"]
st, h, _ = admin("POST", "/crm/tasks", {"title": "Call Lena back", "due_on": today, "owner": ME, "contact_id": str(LENA)})
check("a task is added", "msg=task-created" in loc(h), loc(h))
st, _, html = admin("GET", "/crm/tasks?view=open")
check("and listed with what it is about", st == 200 and "Call Lena back" in html and f"/crm/contacts/{LENA}" in html)
TASK = one("SELECT id FROM crm_tasks WHERE title='Call Lena back'")["id"]
st, h, _ = admin("POST", f"/crm/tasks/{TASK}/done", {"back": "/crm/tasks?view=open"})
check("done", "msg=task-updated" in loc(h) and one(f"SELECT status, completed_by FROM crm_tasks WHERE id={TASK}") ==
      {"status": "done", "completed_by": ME})
st, _, html = admin("GET", "/crm/tasks?view=done")
check("and it moves to Done", "Call Lena back" in html)
st, h, _ = admin("POST", "/crm/tasks", {"title": "", "due_on": today})
check("a task needs a title", "msg=invalid" in loc(h))

print("\n=== linking a lead to their portal family ===")
acct = make_account("lena.family@example.com")
sql(f"INSERT INTO households (display_name, created_at, updated_at) VALUES ('The Lead family', 'n', 'n')")
HH = one("SELECT id FROM households WHERE display_name='The Lead family'")["id"]
sql(f"INSERT INTO household_members (household_id, account_id, role, phone, created_at) VALUES ({HH}, {acct}, 'owner', '(615) 555-0101', 'n')")
sql("INSERT INTO players (display_name, name_norm, parent_email_norm, household_id, created_at, updated_at) "
    f"VALUES ('Lily Lead', 'lily lead', 'lena.family@example.com', {HH}, 'n', 'n')")
LILY = one("SELECT id FROM players WHERE display_name='Lily Lead'")["id"]
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/link", {"guardian_email": "nobody-here@example.com"})
check("a guardian email with no portal family is refused", "msg=no-family" in loc(h), loc(h))
st, h, _ = admin("POST", f"/crm/contacts/{LENA}/link", {"guardian_email": "Lena.Family@example.com"})
check("linking goes to the family's page", st == 303 and loc(h) == f"/crm/families/{HH}?msg=linked", loc(h))
c = one(f"SELECT status, name, email FROM crm_contacts WHERE id={LENA}")
check("the lead is converted: the family is the record now", c == {"status": "converted", "name": None, "email": None}, c)
check("the child's card now belongs to the family's child",
      one(f"SELECT player_id, household_id FROM crm_opportunities WHERE id={CARD}") == {"player_id": LILY, "household_id": HH})
meta = one(f"SELECT owner_email, do_not_contact FROM crm_household_meta WHERE household_id={HH}")
check("the owner and do-not-contact carried over", meta == {"owner_email": "mike@example.com", "do_not_contact": 1}, meta)
st, _, html = admin("GET", f"/crm/families/{HH}")
check("the family page shows the guardian, the child and the history",
      st == 200 and "lena.family@example.com" in html and "Lily Lead" in html and "STAFF-NOTE-CANARY" in html
      and "Does Lily need to try out?" in html, st)
st, _, html = admin("GET", f"/crm/contacts/{LENA}")
check("the old contact page points to the family", "became a portal family" in html and f"/crm/families/{HH}" in html)
st, h, _ = admin("POST", f"/crm/families/{HH}/activity", {"kind": "meeting", "body": "Met at the gym"})
check("staff can log against the family", "msg=logged" in loc(h)
      and one(f"SELECT COUNT(*) AS n FROM crm_activities WHERE household_id={HH} AND kind='meeting'")["n"] == 1, loc(h))

print("\n=== customers ===")
sql("INSERT INTO enrollments (ref, player_id, household_id, program_id, status, applied_at, created_by, created_at, updated_at) "
    f"VALUES ('ref-crm-lily-xxxxxxxx', {LILY}, {HH}, 'academy', 'applied', 'n', 'test', 'n', 'n')")
st, _, html = admin("GET", "/crm/customers")
check("a family with a place is a customer, with the child's status", st == 200 and "The Lead family" in html
      and "Lily Lead: Tennessee Saints Academy Applied" in html, st)
admin("GET", f"/crm/families/{HH}")
check("and the card moves to Applied when the family is opened",
      one(f"SELECT stage FROM crm_opportunities WHERE id={CARD}")["stage"] == "applied")

print("\n=== merge and anonymize (CRM administrators) ===")
sql("INSERT INTO crm_contacts (kind, name, email, email_norm, phone, phone_norm, source, created_at, updated_at) VALUES "
    "('sponsor', 'Sam Sponsor', 'sam@example.com', 'sam@example.com', '(615) 555-0199', '6155550199', 'manual', 'n', 'n'), "
    "('sponsor', 'Samuel S.', 'sam.work@example.com', 'sam.work@example.com', '(615) 555-0199', '6155550199', 'manual', 'n', 'n')")
SAM = one("SELECT id FROM crm_contacts WHERE email_norm='sam@example.com'")["id"]
SAM2 = one("SELECT id FROM crm_contacts WHERE email_norm='sam.work@example.com'")["id"]
sql(f"INSERT INTO crm_inquiries (contact_id, purpose, fields, received_at) VALUES ({SAM2}, 'sponsor', '{{}}', 'n')")
st, _, html = admin("GET", f"/crm/contacts/{SAM}")
check("a shared phone is shown as a possible duplicate", "Possible duplicates" in html and "Samuel S." in html)
merges_before = one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.merge'")["n"]
st, h, _ = admin("POST", f"/crm/contacts/{SAM2}/merge", {"into_id": str(SAM)})
check("merging moves everything and leaves a pointer", loc(h) == f"/crm/contacts/{SAM}?msg=merged"
      and one(f"SELECT status, merged_into_id, email FROM crm_contacts WHERE id={SAM2}") == {"status": "merged", "merged_into_id": SAM, "email": None}
      and one(f"SELECT contact_id FROM crm_inquiries WHERE purpose='sponsor'")["contact_id"] == SAM, loc(h))
check("and is audited", one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.merge'")["n"] == merges_before + 1)
st, h, _ = admin("POST", f"/crm/contacts/{SAM}/merge", {"into_id": str(SAM)})
check("a contact cannot be merged into itself", "msg=invalid" in loc(h))
admin("POST", f"/crm/contacts/{SAM}/activity", {"kind": "note", "body": "ANON-CANARY note"})
st, h, _ = admin("POST", f"/crm/contacts/{SAM}/anonymize", {})
check("anonymizing needs the confirmation box", "msg=confirm" in loc(h) and one(f"SELECT status FROM crm_contacts WHERE id={SAM}")["status"] == "active")
st, h, _ = admin("POST", f"/crm/contacts/{SAM}/anonymize", {"confirm": "yes"})
c = one(f"SELECT status, name, email, phone FROM crm_contacts WHERE id={SAM}")
check("anonymized: name, email and phone are gone", c == {"status": "anonymized", "name": None, "email": None, "phone": None}, c)
check("and so is what staff wrote", one("SELECT COUNT(*) AS n FROM crm_activities WHERE body LIKE '%ANON-CANARY%'")["n"] == 0)
role("coach")
st, _, _ = admin("POST", f"/crm/contacts/{FORMULA['id']}/anonymize", {"confirm": "yes"})
check("a coach cannot anonymize", st == 403 and one(f"SELECT status FROM crm_contacts WHERE id={FORMULA['id']}")["status"] == "active", st)
role("admin")

print("\n=== the evaluation import ===")
sql("INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at) "
    "VALUES ('Omar Old', 'omar old', 'olds@example.com', 'n', 'n')")
OMAR = one("SELECT id FROM players WHERE display_name='Omar Old'")["id"]
sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, parent_name, "
    "parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, assumption_of_risk, "
    "medical_release, photo_release, signature, signed_at, created_at, player_id) VALUES ('2026-08-29-evaluation', '9:00 AM', "
    f"'confirmed', 'tok-crm-olds', 'Omar Old', 'omar old', '5th', 'Olga Old', 'olds@example.com', 'olds@example.com', "
    f"'(615) 555-0123', 'School', 'EC', '615', 1, 1, 1, 'Olga', 'n', 'n', {OMAR})")
imports_before = one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.import'")["n"]
st, _, html = admin("GET", "/crm/import")
check("the import preview counts the new family and child", st == 200 and "New contacts</dt><dd>1" in html
      and "New cards</dt><dd>1" in html, st)
st, _, html = admin("POST", "/crm/import", {})
check("importing adds them", st == 200 and "1 contacts and 1 cards added" in html
      and one(f"SELECT stage FROM crm_opportunities WHERE player_id={OMAR}")["stage"] == "eval_registered", st)
st, _, html = admin("POST", "/crm/import", {})
check("and importing again adds nothing", "0 contacts and 0 cards added" in html)
check("imports are audited", one("SELECT COUNT(*) AS n FROM audit_log WHERE action='crm.import'")["n"] == imports_before + 2)

check.finish()
