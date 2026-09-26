"""Families: setup, children, medical answers, emergency contacts, claiming.

Everything a parent does after signing in and before applying: the details the
academy needs for every child on the court. Asserted from the parent's side
(what the pages do) and the database's side (what was stored, and that audit
rows carry ids, never a child's name or medical text).
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight
from _portal import (BASE, P, WORKER_DIR, Checker, cookie_value, get, make_account, mint_session, post,
                     require_portal, session_cookies, sql)

preflight(BASE)
require_portal()
check = Checker()


def register_eval(name, email, grade="5th", school="Hillsboro Elementary", ip="10.60.0.1"):
    """A past evaluation registration, through the real public endpoint."""
    import urllib.request
    body = json.dumps({
        "session_time": "9:00 AM", "player_name": name, "grade": grade, "years_experience": 2,
        "parent_name": "Pat Parent", "parent_email": email, "phone": "(615) 555-0100", "school": school,
        "emergency_contact_name": "EC Person", "emergency_contact_phone": "(615) 555-0199", "medical_notes": "",
        "player_notes": "Registered for the household tests.", "assumption_of_risk": True,
        "medical_release": True, "photo_release": True, "signature": "Pat Parent", "turnstile_token": "d",
        "elapsed_ms": 9000}).encode()
    req = urllib.request.Request(BASE + "/api/register", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", "https://tnsaints.com")
    req.add_header("CF-Connecting-IP", ip)
    with urllib.request.urlopen(req) as r:
        return r.status


def reg_id(name):
    rows = sql(f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1")
    return rows[0]["id"] if rows else None


CHILD = {"child_name": "Avery Adams", "date_of_birth": "2016-05-14", "grade": "4",
         "school": "Hillsboro Elementary", "shirt_size": "YM"}

for t in ["player_medical", "household_emergency_contacts", "household_invites", "household_members",
          "sessions", "account_identities", "households", "accounts"]:
    sql(f"DELETE FROM {t}")

A = make_account("parent-a@example.com")
S = session_cookies(mint_session(A))
register_eval("Legacy Lane", "parent-a@example.com", ip="10.60.0.1")
register_eval("Noted Kid", "parent-a@example.com", grade="6th", ip="10.60.0.2")
register_eval("Someone Else", "stranger@example.com", ip="10.60.0.3")
# Coaches wrote notes on Noted Kid, which created a player row with no family yet.
sql("INSERT INTO players (display_name, name_norm, parent_email_norm, grade, created_at, updated_at) "
    "VALUES ('Noted Kid', 'noted kid', 'parent-a@example.com', '6th', 'n', 'n')")

print("\n=== signed out, nothing is reachable ===")
st, _, _, html = get(P + "/")
check("/ is the sign-in page", "Email me a sign-in link" in html)
for path in ("/children/new", "/contacts", "/account", "/children/1"):
    st, h, _, _ = get(P + path)
    check(f"GET {path} sends you to sign in", st == 303 and h.get("Location") == P + "/", (st, h.get("Location")))
st, h, _, _ = post(P + "/contacts", {"ec1_name": "x"})
check("a signed-out POST changes nothing and goes to sign in", st == 303 and sql("SELECT 1 FROM household_emergency_contacts") == [])

print("\n=== setting up the family ===")
st, _, _, html = get(P + "/", cookies=S)
check("signed in without a family, / is the setup page", st == 200 and "Set up your family" in html, st)
check("with a sign-out control in the header", f'action="{P}/auth/signout"' in html)
st, h, _, _ = get(P + "/children/new", cookies=S)
check("children cannot be added before the family exists", st == 303, st)
st, _, _, html = post(P + "/family/setup", {"guardian_name": "Pat Adams", "phone": "not a phone",
                                             "relationship": "Mother", "family_name": ""}, cookies=S)
check("a bad phone number is a 400 with the problem linked and the field marked",
      st == 400 and 'href="#phone"' in html and 'aria-invalid="true"' in html, st)
check("and what was typed is kept", 'value="Pat Adams"' in html)
st, _, _, html = post(P + "/family/setup", {"guardian_name": "Pat Adams", "phone": "(615) 555-0142",
                                             "relationship": "Parent from Mars"}, cookies=S)
check("a relationship outside the list is refused", st == 400 and 'href="#relationship"' in html, st)
st, h, _, _ = post(P + "/family/setup", {"guardian_name": "Pat Adams", "phone": "(615) 555-0142",
                                          "relationship": "Mother", "family_name": ""}, cookies=S)
check("valid details create the family (303 back)", st == 303 and h.get("Location") == P + "/", st)
hh = sql(f"SELECT h.id, h.display_name, m.role, m.phone, m.relationship FROM households h "
         f"JOIN household_members m ON m.household_id = h.id WHERE m.account_id = {A}")
check("one household, with this parent as owner", len(hh) == 1 and hh[0]["role"] == "owner", hh)
check("named from the surname when left blank", hh and hh[0]["display_name"] == "The Adams family", hh)
HH = hh[0]["id"] if hh else None
post(P + "/family/setup", {"guardian_name": "Pat Adams", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=S)
check("setting up twice does not make a second family",
      len(sql(f"SELECT 1 FROM household_members WHERE account_id={A}")) == 1)
audit = sql("SELECT actor, subject_type, subject_id, detail FROM audit_log WHERE action='portal.household_create'")
check("setup is audited by id only", audit and audit[-1]["actor"] == f"account:{A}"
      and str(audit[-1]["subject_id"]) == str(HH) and "Adams" not in json.dumps(audit), audit)

print("\n=== the dashboard ===")
st, _, _, html = get(P + "/", cookies=S)
check("the dashboard names the family", st == 200 and "The Adams family" in html, st)
check("it says emergency contacts are needed", "Add at least one person we can call" in html)
check("it offers the two children registered under this email", "Legacy Lane" in html and "Noted Kid" in html)
check("but never a child registered under someone else's email", "Someone Else" not in html)
check("and states that every guardian sees this page", "visible to every guardian" in html)

print("\n=== adding a child ===")
bad = {**CHILD, "date_of_birth": "2024-01-01", "grade": "", "shirt_size": "XXXL", "school": ""}
st, _, _, html = post(P + "/children", bad, cookies=S)
check("an impossible age, missing grade, missing school and unknown shirt size are all reported",
      st == 400 and all(f'href="#{f}"' in html for f in ("date_of_birth", "grade", "school", "shirt_size")), st)
st, _, _, html = post(P + "/children", {**CHILD, "date_of_birth": "2016-02-30"}, cookies=S)
check("a date that does not exist is refused", st == 400 and "real date" in html, st)
st, h, _, _ = post(P + "/children", CHILD, cookies=S)
loc = h.get("Location", "")
m = re.search(r"/children/(\d+)\?saved=added#medical$", loc)
check("a valid child is added and the parent is taken to the medical question", st == 303 and m, (st, loc))
KID = int(m.group(1)) if m else None
row = sql(f"SELECT household_id, parent_email_norm, date_of_birth, grade_level, grade_school_year, school, shirt_size "
          f"FROM players WHERE id={KID}")
check("stored in this family, with every profile field", row and row[0]["household_id"] == HH
      and row[0]["date_of_birth"] == "2016-05-14" and row[0]["grade_level"] == 4 and row[0]["shirt_size"] == "YM", row)
check("the grade is anchored to this school year (so it advances each July)",
      row and isinstance(row[0]["grade_school_year"], int) and row[0]["grade_school_year"] >= 2026, row)
st, _, _, html = post(P + "/children", CHILD, cookies=S)
check("the same name twice in one family is refused", st == 400 and "already added a child with this name" in html, st)
st, _, _, html = post(P + "/children", {**CHILD, "child_name": "Noted Kid"}, cookies=S)
check("a child already on record from an evaluation is steered to 'claim', not duplicated",
      st == 400 and "Add to my family" in html, st)
st, _, _, html = get(P + f"/children/{KID}?saved=added", cookies=S)
check("the child's page opens with the save message and the medical form",
      st == 200 and "Child added" in html and 'name="medical_status"' in html, st)
st, _, _, html = get(P + "/", cookies=S)
check("the dashboard flags the missing medical answer", "Medical answer needed" in html)
check("and shows the grade and shirt size", "4th grade" in html and "Youth M" in html)

print("\n=== the medical answer ===")
st, _, _, html = post(P + f"/children/{KID}/medical", {"medical_status": "declared", "medical_notes": "  "}, cookies=S)
check("'yes' without details is refused", st == 400 and 'href="#medical_notes"' in html, st)
st, _, _, html = post(P + f"/children/{KID}/medical", {}, cookies=S)
check("no answer at all is refused", st == 400 and 'href="#medical_status"' in html, st)
st, h, _, _ = post(P + f"/children/{KID}/medical", {"medical_status": "declared",
                                                     "medical_notes": "Peanut allergy. EpiPen in blue bag."}, cookies=S)
check("details are saved", st == 303 and "saved=medical" in h.get("Location", ""), st)
med = sql(f"SELECT status, notes, updated_by FROM player_medical WHERE player_id={KID}")
check("stored against the child, attributed to the account", med and med[0]["status"] == "declared"
      and "EpiPen" in med[0]["notes"] and med[0]["updated_by"] == f"account:{A}", med)
audit = sql("SELECT detail, subject_id FROM audit_log WHERE action='portal.medical_update'")
check("the audit row carries no medical text and no name",
      audit and "EpiPen" not in json.dumps(audit) and "Avery" not in json.dumps(audit), audit)
st, _, _, html = get(P + "/", cookies=S)
check("the dashboard now shows it is on file", "Medical info on file" in html)
post(P + f"/children/{KID}/medical", {"medical_status": "none_declared", "medical_notes": "leftover text"}, cookies=S)
med = sql(f"SELECT status, notes FROM player_medical WHERE player_id={KID}")
check("'nothing to declare' clears any old details", med and med[0]["status"] == "none_declared" and med[0]["notes"] is None, med)

print("\n=== editing ===")
st, h, _, _ = post(P + f"/children/{KID}", {**CHILD, "school": "Franklin Middle"}, cookies=S)
check("profile edits save", st == 303 and sql(f"SELECT school FROM players WHERE id={KID}")[0]["school"] == "Franklin Middle")
check("and are audited", sql("SELECT 1 FROM audit_log WHERE action='portal.child_update'") != [])

print("\n=== claiming children from past evaluations ===")
LEGACY = reg_id("Legacy Lane")
st, h, _, _ = post(P + "/children/claim", {"registration_id": str(LEGACY)}, cookies=S)
check("claiming answers with the family page and a notice", st == 303 and "notice=claimed" in h.get("Location", ""), h.get("Location"))
p = sql(f"SELECT p.household_id, p.grade_level, p.school FROM players p JOIN registrations r ON r.player_id = p.id "
        f"WHERE r.id={LEGACY}")
check("the child joins the family, with grade and school carried over", p and p[0]["household_id"] == HH
      and p[0]["grade_level"] == 5 and p[0]["school"] == "Hillsboro Elementary", p)
st, _, _, html = get(P + "/", cookies=S)
check("they now appear as a child, not as a suggestion", "Legacy Lane" in html and html.count("Legacy Lane") == 1)
st, h, _, _ = post(P + "/children/claim", {"registration_id": str(LEGACY)}, cookies=S)
check("claiming twice does nothing", "notice=not-claimed" in h.get("Location", ""))
NOTED = reg_id("Noted Kid")
post(P + "/children/claim", {"registration_id": str(NOTED)}, cookies=S)
noted = sql("SELECT household_id FROM players WHERE name_norm='noted kid'")
check("a child with an existing player record (from coach notes) is claimed, not duplicated",
      len(noted) == 1 and noted[0]["household_id"] == HH, noted)
STRANGER = reg_id("Someone Else")
st, h, _, _ = post(P + "/children/claim", {"registration_id": str(STRANGER)}, cookies=S)
check("a child registered under someone else's email cannot be claimed",
      "notice=not-claimed" in h.get("Location", "")
      and sql("SELECT 1 FROM players WHERE name_norm='someone else' AND household_id IS NOT NULL") == [])

print("\n=== emergency contacts ===")
st, _, _, html = post(P + "/contacts", {}, cookies=S)
check("at least one contact is required", st == 400 and 'href="#ec1_name"' in html, st)
st, _, _, html = post(P + "/contacts", {"ec1_name": "Grandma Jo", "ec1_phone": ""}, cookies=S)
check("a half-filled contact is refused", st == 400 and 'href="#ec1_phone"' in html, st)
st, h, _, _ = post(P + "/contacts", {"ec1_name": "Grandma Jo", "ec1_phone": "(615) 555-0111", "ec1_relationship": "Grandmother",
                                     "ec3_name": "Uncle Ray", "ec3_phone": "615-555-0122"}, cookies=S)
check("valid contacts save", st == 303 and "notice=contacts" in h.get("Location", ""), st)
ec = sql(f"SELECT priority, name FROM household_emergency_contacts WHERE household_id={HH} ORDER BY priority")
check("in order, with the gap closed up", [r["name"] for r in ec] == ["Grandma Jo", "Uncle Ray"]
      and [r["priority"] for r in ec] == [1, 2], ec)
post(P + "/contacts", {"ec1_name": "Aunt Sue", "ec1_phone": "(615) 555-0133"}, cookies=S)
ec = sql(f"SELECT name FROM household_emergency_contacts WHERE household_id={HH}")
check("saving again replaces the list", [r["name"] for r in ec] == ["Aunt Sue"], ec)
st, _, _, html = get(P + "/", cookies=S)
check("the dashboard lists them", "Aunt Sue" in html and "Add at least one person" not in html)

print("\n=== headers on family pages ===")
st, h, _, _ = get(P + "/", cookies=S)
hl = {k.lower(): v for k, v in h.items()}
check("never cached, no script, not frameable",
      "no-store" in hl.get("cache-control", "") and "script-src" not in hl.get("content-security-policy", "script-src")
      and hl.get("x-frame-options") == "DENY", hl.get("content-security-policy"))

print("\n=== grades advance by themselves (lib/grades.js) ===")
UNIT = r"""
import { schoolYearOf, currentGrade, gradeLabel, parseLegacyGrade, ageOn } from './src/lib/grades.js';
const d = (s) => new Date(s);
console.log(JSON.stringify({
  years: [schoolYearOf(d('2027-07-01T04:59:00Z')), schoolYearOf(d('2027-07-01T05:01:00Z')), schoolYearOf(d('2027-01-15T12:00:00Z'))],
  grades: [currentGrade(4, 2026, d('2026-09-01T12:00:00Z')), currentGrade(4, 2026, d('2027-07-02T12:00:00Z')),
           currentGrade(12, 2026, d('2027-08-01T12:00:00Z')), currentGrade(null, 2026)],
  labels: [gradeLabel(0), gradeLabel(1), gradeLabel(2), gradeLabel(3), gradeLabel(11)],
  legacy: [parseLegacyGrade('5th'), parseLegacyGrade('K'), parseLegacyGrade('12th'), parseLegacyGrade('pre-k'), parseLegacyGrade('13th')],
  ages: [ageOn('2016-05-14', d('2026-05-13T12:00:00Z')), ageOn('2016-05-14', d('2026-05-14T12:00:00Z')), ageOn('2016-02-30')],
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-300:])
if u:
    check("the school year turns over at midnight Central on July 1", u["years"] == [2026, 2027, 2026], u["years"])
    check("a 4th grader in 2026-27 is a 5th grader from July 2027; past 12th is graduated",
          u["grades"] == [4, 5, None, None], u["grades"])
    check("grade labels read naturally", u["labels"] == ["Kindergarten", "1st grade", "2nd grade", "3rd grade", "11th grade"],
          u["labels"])
    check("evaluation grade strings are understood", u["legacy"] == [5, 0, 12, None, None], u["legacy"])
    check("ages turn over on the birthday; impossible dates are rejected", u["ages"] == [9, 10, None], u["ages"])

check.finish()
