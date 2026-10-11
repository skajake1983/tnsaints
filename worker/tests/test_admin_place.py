"""Add a place, and the yearly waiver (programs/places.js, programs/waiver-season.js).

Asserted: an admin adds a child to a group with room, in a program that is
still a draft (the academy before payments open); the place is active, says how
the family pays today, and takes a seat; the family is then asked to sign the
waiver and can; a full group, a second place in the same program, a bad PayPal
id and a missing choice are refused with the reason, changing nothing; coaches
and viewers cannot reach it; the audit row carries identifiers only.

A signature lasts one season (from August 1): one from an earlier season, or
for an older waiver version, asks the family to sign again, shows staff
"Waiver needed", and signing adds a new consent record, keeping the old.
Needs CONCUSSION_SHEET_URL=https://tnsaints.com/test-concussion-sheet.pdf in .dev.vars.
"""
import hashlib
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()
A = "/__admin"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace")


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


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

# The academy as it is before payments open: a draft, with a waiver and one group of two seats.
WAIVER = "PLACE TEST WAIVER. Basketball involves risk."
sql("UPDATE programs SET status='draft', waiver_version_id=NULL WHERE id='academy'")
sql("DELETE FROM waiver_versions WHERE id IN ('place-test-v1', 'place-test-v2')")
sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
    f"('place-test-v1', 'Test entity', 'Test waiver', '{WAIVER}', '{hashlib.sha256(WAIVER.encode()).hexdigest()}', "
    "datetime('now'), datetime('now'))")
sql("UPDATE programs SET waiver_version_id='place-test-v1' WHERE id='academy'")
sql("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at) "
    "VALUES ('academy', 'Tuesday group', 'Tuesdays 6:00-7:30 PM', 2, datetime('now'), datetime('now'))")
GID = one("SELECT id FROM program_groups WHERE name='Tuesday group'")["id"]

kids, cookies = {}, {}
for email, name, children in (("place-a@example.com", "Adams", ["Ava Adams", "Ben Adams"]),
                              ("place-b@example.com", "Brown", ["Cal Brown"])):
    s = session_cookies(mint_session(make_account(email)))
    cookies[name] = s
    post(P + "/family/setup", {"guardian_name": f"Pat {name}", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=s)
    for child in children:
        post(P + "/children", {"child_name": child, "date_of_birth": "2016-04-04", "grade": "4", "school": "Test School",
                               "shirt_size": "YM"}, cookies=s)
        kids[child] = one(f"SELECT id FROM players WHERE display_name='{child}'")["id"]
AVA, BEN, CAL = kids["Ava Adams"], kids["Ben Adams"], kids["Cal Brown"]

print("\n=== the form ===")
st, _, html = admin("GET", "/families")
check("each child on the Families page has an 'Add a place' link", st == 200 and f"/families/children/{AVA}/place" in html, st)
st, _, html = admin("GET", f"/families/children/{AVA}/place")
check("the form names the child and offers the academy's groups, draft or not", st == 200 and "Add a place for Ava Adams" in html
      and "Tuesday group" in html and "(draft)" in html and "0 of 2 seats" in html, st)
st, _, _ = admin("GET", "/families/children/999999/place")
check("an unknown child is not found", st == 404, st)

print("\n=== adding a place ===")
st, _, html = admin("POST", f"/families/children/{AVA}/place", {"group_id": str(GID)})
check("how the family pays is required", st == 400 and "Choose how the family pays today." in html and 'role="alert"' in html, st)
st, _, html = admin("POST", f"/families/children/{AVA}/place", {"group_id": str(GID), "billed_outside": "other",
                                                                  "outside_reference": "I-ABC123DEF456"})
check("a PayPal id only goes with a PayPal place", st == 400 and "subscription id looks like" in html, st)
st, _, html = admin("POST", f"/families/children/{AVA}/place", {"group_id": str(GID), "billed_outside": "paypal_join",
                                                                  "outside_reference": "not-an-id"})
check("a PayPal id must look like one", st == 400 and "subscription id looks like" in html, st)
check("nothing was added by the refused forms", one("SELECT COUNT(*) AS n FROM enrollments")["n"] == 0)
st, h, _ = admin("POST", f"/families/children/{AVA}/place", {"group_id": str(GID), "billed_outside": "paypal_join",
                                                               "outside_reference": "i-abc123def456"})
check("a place is added", st == 303 and h.get("location", "").endswith("/families?msg=placed"), (st, h.get("location")))
e = one(f"SELECT status, group_id, program_id, billed_outside, outside_reference, created_by, decided_by, consent_record_id "
        f"FROM enrollments WHERE player_id={AVA}")
check("active, in the group, paid through PayPal with its id, by this admin, no waiver yet",
      e == {"status": "active", "group_id": GID, "program_id": "academy", "billed_outside": "paypal_join",
            "outside_reference": "I-ABC123DEF456", "created_by": ME, "decided_by": ME, "consent_record_id": None}, e)
st, _, html = admin("GET", f"/families/children/{AVA}/place")
check("the place takes a seat", "1 of 2 seats" in html and "Already: Tennessee Saints Academy (active, Tuesday group)" in html)
st, _, html = admin("POST", f"/families/children/{AVA}/place", {"group_id": str(GID), "billed_outside": "other"})
check("a second place in the same program is refused", st == 409 and "already has a place" in html
      and one(f"SELECT COUNT(*) AS n FROM enrollments WHERE player_id={AVA}")["n"] == 1, st)
admin("POST", f"/families/children/{BEN}/place", {"group_id": str(GID), "billed_outside": "other"})
st, _, html = admin("POST", f"/families/children/{CAL}/place", {"group_id": str(GID), "billed_outside": "other"})
check("a full group is refused, and says so", st == 409 and "filled up" in html
      and one(f"SELECT COUNT(*) AS n FROM enrollments WHERE player_id={CAL}")["n"] == 0, st)
st, _, html = admin("GET", f"/families/children/{CAL}/place")
check("and shows as full, not choosable", re.search(r'<option value="\d+" disabled>Tuesday group[^<]*full', html) is not None)
audit = sql("SELECT detail FROM audit_log WHERE action='enrollment.place_added' ORDER BY id DESC LIMIT 1")
check("the audit row carries identifiers only", audit and "academy" in audit[0]["detail"]
      and "Ava" not in audit[0]["detail"] and "I-ABC" not in audit[0]["detail"], audit)

print("\n=== the family signs the waiver ===")
st, _, _, html = get(P + "/", cookies=cookies["Adams"])
check("the family page asks for the waiver", st == 200 and "Action needed: sign the waiver" in html, st)
st, h, _, _ = post(P + f"/children/{AVA}/waiver/academy",
                   {"waiver_version": "place-test-v1", "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
                    "photo_release": "no", "signature": "Pat Adams", "relationship": "Mother"}, cookies=cookies["Adams"])
check("they sign it, and it is attached to the place", st == 303 and one(
    f"SELECT consent_record_id IS NOT NULL AS signed FROM enrollments WHERE player_id={AVA}")["signed"] == 1, st)
st, _, _, _ = get(P + f"/children/{AVA}/waiver/academy", cookies=cookies["Brown"])
check("another family cannot open it", st == 404, st)
st, _, _, html = get(P + f"/children/{BEN}/waiver/academy", cookies=cookies["Adams"])
check("the waiver form links Tennessee's concussion sheet (CONCUSSION_SHEET_URL)", st == 200
      and 'href="https://tnsaints.com/test-concussion-sheet.pdf"' in html and "concussion and head injury information sheet" in html, st)

print("\n=== a new season, or a new version, asks again (every August 1) ===")


def kid_block(html, name):
    m = re.search(r"<strong>" + re.escape(name) + r"</strong>(.*?)</div>", html, re.S)
    return m.group(1) if m else ""


st, _, html = admin("GET", "/families")
check("staff see who still needs to sign: Ben yes, Ava no", "Waiver needed" in kid_block(html, "Ben Adams")
      and "Waiver needed" not in kid_block(html, "Ava Adams"))
fam = one(f"SELECT household_id FROM players WHERE id={AVA}")["household_id"]
acct = one(f"SELECT account_id FROM household_members WHERE household_id={fam}")["account_id"]
SHA1 = hashlib.sha256(WAIVER.encode()).hexdigest()
first_consent = one(f"SELECT consent_record_id AS id FROM enrollments WHERE player_id={AVA}")["id"]
# Last season's signature (consent records are append-only, so add an old one and point the place at it).
sql("INSERT INTO consent_records (player_id, household_id, account_id, program_id, waiver_version_id, waiver_sha256, signature, "
    "signer_relationship, esign_consent, assumption_of_risk, medical_release, photo_release, signed_at) VALUES "
    f"({AVA}, {fam}, {acct}, 'academy', 'place-test-v1', '{SHA1}', 'Pat Adams', 'Mother', 1, 1, 1, 0, '2020-08-02T12:00:00.000Z')")
OLD = one(f"SELECT id FROM consent_records WHERE player_id={AVA} AND signed_at LIKE '2020-%'")["id"]
sql(f"UPDATE enrollments SET consent_record_id={OLD} WHERE player_id={AVA}")
st, _, _, html = get(P + "/", cookies=cookies["Adams"])
check("a signature from an earlier season: the family is asked again", "Action needed: sign this season's waiver" in html)
st, _, _, html = get(P + f"/children/{AVA}/waiver/academy", cookies=cookies["Adams"])
check("the signing page says why", st == 200 and "A new season has started, or the waiver has changed" in html, st)
st, _, html = admin("GET", "/families")
check("and staff see it", "Waiver needed" in kid_block(html, "Ava Adams"))
SIGN = {"agree_risk": "on", "agree_medical": "on", "agree_esign": "on", "photo_release": "yes", "signature": "Pat Adams",
        "relationship": "Mother"}
st, h, _, _ = post(P + f"/children/{AVA}/waiver/academy", {"waiver_version": "place-test-v1", **SIGN}, cookies=cookies["Adams"])
now_consent = one(f"SELECT consent_record_id AS id FROM enrollments WHERE player_id={AVA}")["id"]
check("signing again adds a new record and the place points at it; the old ones stay", st == 303
      and now_consent not in (OLD, first_consent)
      and one(f"SELECT COUNT(*) AS n FROM consent_records WHERE player_id={AVA}")["n"] == 3, (st, now_consent))
st, h, _, _ = post(P + f"/children/{AVA}/waiver/academy", {"waiver_version": "place-test-v1", **SIGN}, cookies=cookies["Adams"])
check("once signed for this season, signing again does nothing",
      one(f"SELECT COUNT(*) AS n FROM consent_records WHERE player_id={AVA}")["n"] == 3)
# A new version of the waiver (for example, naming the non-profit).
W2 = "PLACE TEST WAIVER v2. Basketball involves risk."
sql("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) VALUES "
    f"('place-test-v2', 'Test entity', 'Test waiver', '{W2}', '{hashlib.sha256(W2.encode()).hexdigest()}', "
    "datetime('now'), datetime('now'))")
sql("UPDATE programs SET waiver_version_id='place-test-v2' WHERE id='academy'")
st, _, _, html = get(P + "/", cookies=cookies["Adams"])
check("a new waiver version: asked again", "Action needed: sign this season's waiver" in html)
st, h, _, _ = post(P + f"/children/{AVA}/waiver/academy", {"waiver_version": "place-test-v2", **SIGN}, cookies=cookies["Adams"])
c = one(f"SELECT c.waiver_version_id FROM enrollments e JOIN consent_records c ON c.id = e.consent_record_id WHERE e.player_id={AVA}")
check("and the new signature is for the new version", st == 303 and c == {"waiver_version_id": "place-test-v2"}, (st, c))

print("\n=== who may ===")
for r in ("coach", "viewer"):
    role(r)
    st, _, html = admin("GET", "/families")
    st2, _, _ = admin("GET", f"/families/children/{CAL}/place")
    st3, _, _ = admin("POST", f"/families/children/{CAL}/place", {"group_id": str(GID), "billed_outside": "other"})
    check(f"a {r} sees no link and is refused the page and the form", "/place" not in html and st2 == 403 and st3 == 403,
          (st2, st3))
role("admin")

check.finish()
