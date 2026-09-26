"""No family can see or change another family's children (IDOR).

Two families, A and B, each with a child, a medical answer and contacts.
Signed in as A, every family route is walked with B's ids. Each must answer
exactly like an id that does not exist (the same 404 page, byte for byte), B's
rows must be unchanged afterwards, and none of B's data may appear in anything
A is shown.

When a route is added to the portal, add it here.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
require_portal()
check = Checker()

for t in ["player_medical", "household_emergency_contacts", "household_invites", "household_members",
          "sessions", "account_identities", "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")

A = make_account("family-a@example.com")
B = make_account("family-b@example.com")
SA = session_cookies(mint_session(A))
SB = session_cookies(mint_session(B))

for s, name in ((SA, "Alpha"), (SB, "Bravo")):
    post(P + "/family/setup", {"guardian_name": f"{name} Parent", "phone": "(615) 555-0100", "relationship": "Father"}, cookies=s)
    post(P + "/children", {"child_name": f"{name} Child", "date_of_birth": "2015-03-03", "grade": "5",
                           "school": f"{name} School", "shirt_size": "YL"}, cookies=s)
    post(P + "/contacts", {"ec1_name": f"{name} Contact", "ec1_phone": "(615) 555-0199"}, cookies=s)

KID_A = sql("SELECT id FROM players WHERE display_name='Alpha Child'")[0]["id"]
KID_B = sql("SELECT id FROM players WHERE display_name='Bravo Child'")[0]["id"]
post(P + f"/children/{KID_B}/medical", {"medical_status": "declared", "medical_notes": "BRAVO-SECRET asthma"}, cookies=SB)

B_BEFORE = {
    "player": sql(f"SELECT * FROM players WHERE id={KID_B}"),
    "medical": sql(f"SELECT status, notes FROM player_medical WHERE player_id={KID_B}"),
    "contacts": sql("SELECT name, phone FROM household_emergency_contacts WHERE name LIKE 'Bravo%'"),
}
MISSING = 987654321
_, _, _, not_found_page = get(P + f"/children/{MISSING}", cookies=SA)

print("\n=== A reading B's child ===")
st, _, _, body = get(P + f"/children/{KID_B}", cookies=SA)
check("B's child page is a 404 for A", st == 404, st)
check("byte-identical to a child that does not exist", body == not_found_page)
check("with none of B's details in it", not any(s in body for s in ("Bravo", "BRAVO-SECRET")))

print("\n=== A writing to B's child ===")
st, _, _, body = post(P + f"/children/{KID_B}", {"child_name": "Hijacked", "date_of_birth": "2015-03-03", "grade": "5",
                                                  "school": "Evil School", "shirt_size": "YS"}, cookies=SA)
check("editing B's child is a 404", st == 404 and body == not_found_page, st)
st, _, _, body = post(P + f"/children/{KID_B}/medical", {"medical_status": "none_declared"}, cookies=SA)
check("overwriting B's child's medical answer is a 404", st == 404 and body == not_found_page, st)
st, _, _, body = post(P + f"/children/{KID_B}/medical", {"medical_status": "declared", "medical_notes": ""}, cookies=SA)
check("even an invalid medical post reveals nothing (404, not a validation error)", st == 404, st)
st, _, _, body = post(P + f"/children/{MISSING}", {"child_name": "x"}, cookies=SA)
check("and a missing id answers the same way", st == 404 and body == not_found_page, st)

print("\n=== A claiming B's registration ===")
import json as _json
import urllib.request as _ur
_req = _ur.Request(BASE + "/api/register", method="POST", data=_json.dumps({
    "session_time": "9:00 AM", "player_name": "Bravo Legacy", "grade": "5th", "years_experience": 1,
    "parent_name": "Bravo Parent", "parent_email": "family-b@example.com", "phone": "(615) 555-0100",
    "school": "Bravo School", "emergency_contact_name": "EC Person", "emergency_contact_phone": "(615) 555-0199",
    "medical_notes": "", "player_notes": "Registered for the IDOR tests.", "assumption_of_risk": True,
    "medical_release": True, "photo_release": True, "signature": "Bravo Parent", "turnstile_token": "d",
    "elapsed_ms": 9000}).encode())
_req.add_header("Content-Type", "application/json")
_req.add_header("Origin", "https://tnsaints.com")
_req.add_header("CF-Connecting-IP", "10.70.0.9")
_ur.urlopen(_req).read()
reg_b = sql("SELECT id FROM registrations WHERE player_name='Bravo Legacy'")
check("setup: B has a past registration", bool(reg_b))
st, h, _, _ = post(P + "/children/claim", {"registration_id": str(reg_b[0]["id"]) if reg_b else "0"}, cookies=SA)
check("A cannot claim a child registered under B's email", "not-claimed" in h.get("Location", ""), h.get("Location"))
check("and no player for that child joined A's family",
      sql("SELECT 1 FROM players WHERE name_norm='bravo legacy' AND household_id IS NOT NULL") == [])
st, _, _, body = get(P + "/", cookies=SA)
check("nor is it offered to A", "Bravo Legacy" not in body)
st, h, _, _ = post(P + "/children/claim", {"registration_id": "not-a-number"}, cookies=SA)
check("a malformed claim does nothing", "not-claimed" in h.get("Location", ""))

print("\n=== nothing of B's leaks into A's pages ===")
for path in ("/", "/contacts", "/account", f"/children/{KID_A}"):
    st, _, _, body = get(P + path, cookies=SA)
    check(f"A's {path} shows none of B's data", st == 200 and not any(s in body for s in ("Bravo", "BRAVO-SECRET")),
          (st, [s for s in ("Bravo", "BRAVO-SECRET") if s in body]))

print("\n=== B is exactly as it was ===")
check("B's child is unchanged", sql(f"SELECT * FROM players WHERE id={KID_B}") == B_BEFORE["player"])
check("B's medical answer is unchanged",
      sql(f"SELECT status, notes FROM player_medical WHERE player_id={KID_B}") == B_BEFORE["medical"])
check("B's contacts are unchanged",
      sql("SELECT name, phone FROM household_emergency_contacts WHERE name LIKE 'Bravo%'") == B_BEFORE["contacts"])
check("A's contacts save never touched B's (per-household replace)",
      len(sql("SELECT 1 FROM household_emergency_contacts WHERE name LIKE 'Bravo%'")) == 1)

print("\n=== and the same holds the other way ===")
st, _, _, body = get(P + f"/children/{KID_A}", cookies=SB)
check("B cannot open A's child either", st == 404, st)
st, _, _, body = get(P + f"/children/{KID_B}", cookies=SB)
check("while B still sees their own child", st == 200 and "Bravo Child" in body, st)

check.finish()
