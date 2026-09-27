"""Portal families for staff (src/programs/families.js, admin/families-ui.js).

The roster's minimisation rules, applied to portal families: a coach sees
children, grades, shirt sizes and whether a medical note exists; guardians'
contact details and the note itself are absent from a coach's page, not hidden.
Admins read a note one child at a time, and every read — and every refused
attempt — is audited without the note's text.
"""
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(path):
    req = urllib.request.Request(BASE + "/__admin" + path)
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), r.read().decode("utf-8", "replace")


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


for t in ["payments", "billing_subscriptions", "enrollments", "consent_records", "program_groups", "player_medical",
          "household_emergency_contacts", "household_invites", "household_members", "sessions", "account_identities",
          "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

kids = {}
for email, name, children in (("fam-a@example.com", "Adams", [("Ava Adams", "YM", "declared"), ("Ben Adams", "YL", "none_declared")]),
                              ("fam-b@example.com", "Brown", [("Cal Brown", "YM", None)])):
    s = session_cookies(mint_session(make_account(email)))
    post(P + "/family/setup", {"guardian_name": f"Pat {name}", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=s)
    post(P + "/contacts", {"ec1_name": f"Grandma {name}", "ec1_phone": "(615) 555-0111"}, cookies=s)
    for child, size, med in children:
        post(P + "/children", {"child_name": child, "date_of_birth": "2016-04-04", "grade": "4", "school": "Test School",
                               "shirt_size": size}, cookies=s)
        kids[child] = sql(f"SELECT id FROM players WHERE display_name='{child}'")[0]["id"]
        if med == "declared":
            post(P + f"/children/{kids[child]}/medical", {"medical_status": "declared", "medical_notes": "SECRET-ASTHMA inhaler"}, cookies=s)
        elif med:
            post(P + f"/children/{kids[child]}/medical", {"medical_status": med}, cookies=s)

sql("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at) "
    "VALUES ('academy', 'Tuesday group', 'Tuesdays', 10, datetime('now'), datetime('now'))")
gid = sql("SELECT id FROM program_groups")[0]["id"]
hh = {r["display_name"]: r["id"] for r in sql("SELECT id, display_name FROM households")}
for child, status in (("Ava Adams", "active"), ("Ben Adams", "applied"), ("Cal Brown", "offered")):
    household = hh["The Adams family"] if "Adams" in child else hh["The Brown family"]
    group = gid if status in ("active", "offered") else "NULL"
    expiry = "'2099-01-01T00:00:00.000Z'" if status == "offered" else "NULL"
    sql("INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, offer_expires_at, applied_at, "
        f"created_by, created_at, updated_at) VALUES ('ref-{kids[child]}-xxxxxxxxxxxx', {kids[child]}, {household}, 'academy', "
        f"{group}, '{status}', {expiry}, datetime('now'), 'test', datetime('now'), datetime('now'))")

print("\n=== an admin's view ===")
st, html = admin("/families")
check("the families page opens", st == 200 and "The Adams family" in html and "The Brown family" in html, st)
check("it counts families and children", "2 families and 3 children" in html)
check("each child's grade, shirt and academy status", "4th grade" in html and "Shirt YM" in html
      and "Enrolled: Tuesday group" in html and "Applied" in html and "Offered: Tuesday group" in html)
check("medical: a link to a note, 'no medical', or 'not answered'",
      "/families/children/" in html and "No medical" in html and "Medical not answered" in html)
check("admins see guardians' contact details and emergency contacts",
      "fam-a@example.com" in html and "(615) 555-0142" in html and "Grandma Adams" in html)
check("but never a medical note's text on the list", "SECRET-ASTHMA" not in html)
check("shirts to order count only offered and enrolled children",
      "To order (offered or enrolled): <strong>YM</strong> 2" in html and "<strong>YL</strong> 2" not in html.split("All children")[0])
check("and all children separately", "All children: <strong>YM</strong> 2 · <strong>YL</strong> 1" in html)

print("\n=== reading a medical note ===")
st, html = admin(f"/families/children/{kids['Ava Adams']}/medical")
check("an admin can open one child's note", st == 200 and "SECRET-ASTHMA inhaler" in html, st)
check("and is told the read is recorded", "recorded in the audit log" in html)
a = sql("SELECT actor, subject_type, subject_id, detail FROM audit_log WHERE action='medical.read' ORDER BY id DESC LIMIT 1")
check("the read is audited against the player, without the text",
      a and a[0]["subject_type"] == "player" and str(a[0]["subject_id"]) == str(kids["Ava Adams"])
      and "SECRET" not in str(a), a)
st, _ = admin("/families/children/999999/medical")
check("a child who is not on the portal is a 404", st == 404, st)

print("\n=== a coach's view ===")
role("coach")
st, html = admin("/families")
check("a coach sees the families and children", st == 200 and "Ava Adams" in html, st)
check("but no guardian email or phone and no emergency contacts — absent, not hidden",
      "fam-a@example.com" not in html and "(615) 555-0142" not in html and "Grandma Adams" not in html)
check("and a medical flag with no way in", "Medical note" in html and "/families/children/" not in html)
st, html = admin(f"/families/children/{kids['Ava Adams']}/medical")
check("a coach who goes to a note's address is refused", st == 403 and "SECRET-ASTHMA" not in html, st)
d = sql("SELECT action, subject_id FROM audit_log WHERE action='medical.denied' ORDER BY id DESC LIMIT 1")
check("and the refused attempt is audited too", d and str(d[0]["subject_id"]) == str(kids["Ava Adams"]), d)
role("admin")

check.finish()
