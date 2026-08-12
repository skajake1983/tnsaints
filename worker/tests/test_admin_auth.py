"""Admin surface: authentication, authorization, and data minimisation.

The tests that matter most here are the REFUSALS. A dashboard that shows the
right things to the right person is pleasant; one that shows a coach a child's
medical note is the failure this whole layer exists to prevent, so most of what
follows asserts absence rather than presence.

Requires the local dev server with DEV_ADMIN_EMAIL set in .dev.vars. Locally
the admin surface lives under /__admin because wrangler dev cannot simulate a
second hostname; in production it is admin.tnsaints.com behind Cloudflare
Access. The authorization path being tested is identical either way -- only the
authentication step differs.
"""
import json
import subprocess
import urllib.request
import urllib.error

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email


BASE = "http://127.0.0.1:8787"

preflight(BASE)
ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"

# Read from .dev.vars rather than hardcoded: this repo is public, and there is
# no reason to publish which mailboxes are on the Access allow-list.
STAFF_EMAIL = staff_email()

passed, failed = [], []


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail and not cond else ""))


WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _wrangler(command):
    """Run a D1 command and return its output as text.

    Decoding is pinned to UTF-8 with replacement. Python on Windows defaults to
    cp1252 for subprocess output, and wrangler prints box-drawing characters --
    which crashes the decode and, worse, returns None rather than failing
    loudly, so an assertion against the output silently has nothing to assert.
    """
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "tnsaints", "--local", "--command", command],
        capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR,
    )
    return (res.stdout or b"").decode("utf-8", errors="replace")


def sql(command):
    """Run SQL against the local D1. Used to set up staff rows, which have no
    API yet -- Phase A deliberately manages staff by command, not by a UI that
    would itself need protecting."""
    _wrangler(command)


def call(method, path, body=None, origin=ORIGIN, ip=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    if ip:
        req.add_header("CF-Connecting-IP", ip)
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


def set_role(role):
    sql(f"UPDATE staff SET role='{role}' WHERE email_norm='{STAFF_EMAIL}'")


def add_staff(role="admin"):
    sql(
        "INSERT OR REPLACE INTO staff "
        "(email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{STAFF_EMAIL}', 'Jacob Adams', 'Coach Adams', '{role}', 1, "
        "datetime('now'), datetime('now'))"
    )


# Canary values planted in one registration. Any of these appearing in a
# response that should not carry them is a leak, regardless of which field or
# template put it there.
CANARIES = {
    "parent name": "CANARY-PARENT-NAME",
    "parent email": "CANARY-PARENT-EMAIL@example.com",
    "emergency contact": "CANARY-EMERGENCY-NAME",
    "medical note text": "CANARY-MEDICAL-SECRET",
    "signature": "CANARY-SIGNATURE",
    "phone": "555-7788",
}


def plant_registration():
    sql("DELETE FROM registrations; DELETE FROM email_budget;")
    st, r = call("POST", "/api/register", {
        "session_time": "9:00 AM", "player_name": "Marcus Canary", "grade": "5th",
        "years_experience": 3, "parent_name": CANARIES["parent name"],
        "parent_email": CANARIES["parent email"], "phone": "(615) 555-7788",
        "school": "Franklin Elementary",
        "emergency_contact_name": CANARIES["emergency contact"],
        "emergency_contact_phone": "(615) 555-9911",
        "medical_notes": CANARIES["medical note text"] + " peanut allergy",
        "player_notes": "Good motor, needs left hand work over the season.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": CANARIES["signature"], "turnstile_token": "dummy",
    }, ip="10.90.0.1")
    return st == 200


print("\n=== 1. authenticated but not on the staff list ===")
sql("DELETE FROM staff; DELETE FROM audit_log;")
st, body = call("GET", ADMIN + "/")
# 403, not 401: Cloudflare Access admitted this person. Being through the door
# is not the same as being on the list, and this is the control that survives
# the Access policy being widened to "anyone with an @tnsaints.com address".
check("unknown staff is refused with 403", st == 403, f"got {st}")
check("refusal explains it is an authorisation problem, not a login one",
      isinstance(body, str) and "not yet authorised" in body.lower(), str(body)[:120])
check("refusal names who to contact rather than dead-ending",
      isinstance(body, str) and "jacob" in body.lower(), str(body)[:120])

st, rows = call("GET", ADMIN + "/api/roster")
check("roster data is refused too, not just the page", st == 403, f"got {st}")

print("\n=== 2. an active staff member gets in ===")
add_staff("admin")
st, _ = call("GET", ADMIN + "/")
check("listed admin reaches the roster", st == 200, f"got {st}")
st, who = call("GET", ADMIN + "/api/health")
check("identity is resolved from the verified email, not a request field",
      st == 200 and who.get("principal") == STAFF_EMAIL, str(who))

print("\n=== 3. deactivating revokes access immediately ===")
sql(f"UPDATE staff SET active=0 WHERE email_norm='{STAFF_EMAIL}'")
st, _ = call("GET", ADMIN + "/")
check("active=0 is refused", st == 403, f"got {st}")
sql(f"UPDATE staff SET active=1 WHERE email_norm='{STAFF_EMAIL}'")
st, _ = call("GET", ADMIN + "/")
check("reactivating restores access", st == 200, f"got {st}")

print("\n=== 4. data minimisation: what each role actually receives ===")
check("test registration planted", plant_registration())

for role, may_see_contact in [("coach", False), ("viewer", False), ("admin", True)]:
    set_role(role)
    _, html = call("GET", ADMIN + "/")
    _, rows = call("GET", ADMIN + "/api/roster")
    blob = str(html) + json.dumps(rows)

    # The medical note TEXT is withheld from every role, including admin. It is
    # readable only through the audited single-record endpoint below.
    check(f"{role}: medical note text never in the roster",
          CANARIES["medical note text"] not in blob)

    # Capability tokens are never in any projection for anyone.
    check(f"{role}: cancel_token absent", "cancel_token" not in blob)
    check(f"{role}: ip_hash absent", "ip_hash" not in blob)

    for name in ("parent email", "emergency contact", "signature", "phone"):
        present = CANARIES[name] in blob
        if may_see_contact:
            check(f"{role}: {name} available", present)
        else:
            # Not hidden by CSS, not omitted by the template -- absent from the
            # bytes, so there is nothing for a view-source or a future template
            # bug to expose.
            check(f"{role}: {name} NOT in the response bytes", not present)

    # Everyone still needs to know a note exists so a child gets care -- but the
    # *shape* of that flag is the authorization boundary made visible. An admin
    # gets a reveal button wired to the audited endpoint; a coach or viewer gets
    # the static "see Jacob" text and no button at all. If a template change ever
    # handed a coach the button, the note is one unaudited click away.
    check(f"{role}: sees the player", "Marcus Canary" in str(html))
    # The parent's NAME is shown to every role — a coach needs to know whose
    # parent they are speaking to. The means of reaching them (email, phone,
    # emergency contact), asserted absent above for non-contact roles, is not.
    check(f"{role}: sees the parent's name", CANARIES["parent name"] in str(html))
    if role == "admin":
        check("admin: gets a reveal button, not the static flag",
              "data-medical=" in str(html) and "see Jacob" not in str(html))
        check("admin: the reveal modal is present on the page",
              'id="medBackdrop"' in str(html))
    else:
        check(f"{role}: gets the static flag and NO reveal button",
              "see Jacob" in str(html) and "data-medical=" not in str(html))

    # The wide columns are gone; everything else is behind the "Registration"
    # which opens a vertical detail modal. The detail is server-rendered into a
    # hidden <template> from the SAME minimised projection, so a coach's page
    # carries the button but the template holds no contact fields (already
    # asserted absent above).
    check(f"{role}: has a View-registration button and the detail modal",
          "data-detail=" in str(html) and 'id="regBackdrop"' in str(html))
    check(f"{role}: the vertical detail rendered", "<template id=\"reg-" in str(html)
          and "Player notes" in str(html))
    # The narrow table must not carry the long free-text columns that forced the
    # horizontal scrollbar — those live in the detail now.
    check(f"{role}: the wide Email/Phone columns are gone from the table",
          "<th>Email</th>" not in str(html) and "<th>Phone</th>" not in str(html))

print("\n=== 4b. the reveal button actually runs: script parses and its CSP hash matches ===")
# The button does nothing unless the browser runs the inline script, and the
# browser refuses to run it unless the served bytes hash to the value declared
# in script-src. A whitespace-level drift between the two silently disables the
# reveal on the real site while every server-side test still passes -- so assert
# the two agree, and that the script is valid JS in the first place.
import base64, hashlib, re
set_role("admin")
req = urllib.request.Request(BASE + ADMIN + "/", method="GET")
req.add_header("Origin", ORIGIN)
csp, html = "", ""
try:
    with urllib.request.urlopen(req) as rsp:
        csp = rsp.headers.get("Content-Security-Policy", "")
        html = rsp.read().decode()
except urllib.error.HTTPError as e:
    check("the roster page is reachable as admin", False, f"got {e.code}")
declared = re.search(r"script-src '(sha256-[^']+)'", csp)
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
check("the roster carries a hashed inline script", bool(declared) and bool(scripts),
      f"csp={csp[:80]}")
# The reveal fetch is a same-origin XHR, so connect-src must permit 'self' or the
# button opens the modal and then fails to load the note.
check("connect-src permits the same-origin reveal fetch", "connect-src 'self'" in csp,
      f"csp={csp[:120]}")
if declared and scripts:
    actual = "sha256-" + base64.b64encode(
        hashlib.sha256(scripts[-1].encode("utf-8")).digest()).decode()
    check("the declared hash matches the served reveal script", declared.group(1) == actual,
          f"{declared.group(1)} vs {actual}")
    tmp = os.path.join(WORKER_DIR, ".roster-script-check.js")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(scripts[-1])
    try:
        res = subprocess.run(["node", "--check", tmp], capture_output=True,
                             shell=(os.name == "nt"), cwd=WORKER_DIR)
        check("the served reveal script is valid JavaScript", res.returncode == 0,
              (res.stderr or b"").decode("utf-8", "replace")[:200])
    finally:
        try: os.remove(tmp)
        except OSError: pass

print("\n=== 5. medical notes: readable by admin, audited, refused to coaches ===")
_, rows = call("GET", ADMIN + "/api/roster")
set_role("admin")
_, rows = call("GET", ADMIN + "/api/roster")
reg_id = rows["registrations"][0]["id"]

set_role("coach")
st, body = call("GET", f"{ADMIN}/api/roster/{reg_id}/medical")
check("coach is refused the medical note", st == 403, f"got {st}")
check("refusal does not leak the note", CANARIES["medical note text"] not in json.dumps(body))

set_role("admin")
st, body = call("GET", f"{ADMIN}/api/roster/{reg_id}/medical")
check("admin can read the medical note", st == 200 and CANARIES["medical note text"] in json.dumps(body),
      str(body)[:160])

st, body = call("GET", f"{ADMIN}/api/roster/999999/medical")
check("unknown registration is 404", st == 404, f"got {st}")

print("\n=== 6. the audit trail records access without copying the data ===")
log = _wrangler(
    "SELECT actor, action, subject_id, detail FROM audit_log ORDER BY id DESC LIMIT 20"
)
check("a medical read was logged", "medical.read" in log, log[-300:])
check("a refused medical read was logged", "medical.denied" in log, log[-300:])
check("a not-on-staff denial was logged", "admin.denied" in log, log[-300:])
# An audit log holding the medical text would put the most sensitive field in
# the database into a second table with different access rules.
check("the audit log does NOT contain the note text",
      CANARIES["medical note text"] not in log)
check("the audit log does NOT contain contact details",
      CANARIES["parent email"] not in log)

print("\n=== 7. the admin surface does not exist on the public API ===")
for path in ("/", "/profile", "/api/roster", "/api/health"):
    st, body = call("GET", path)
    if path == "/api/health":
        # The public API has its own health endpoint; it must not name a principal.
        check("public /api/health reveals no principal",
              st == 200 and "principal" not in json.dumps(body), str(body))
    else:
        check(f"public API has no {path}", st == 404, f"got {st}")

print("\n=== 8. the local dev bypass refuses anything from the Cloudflare edge ===")
# This guard has been written wrong twice: once keyed on the request hostname
# (which wrangler dev rewrites, so it never fired), once on ACCESS_AUD being
# empty (which died the moment Access was genuinely configured). It is now
# keyed on the absence of Cf-Ray, a fact about the request rather than about
# configuration -- pinned here so a third rewrite has to stay honest.
req = urllib.request.Request(BASE + ADMIN + "/", method="GET")
req.add_header("Cf-Ray", "a28c36137db46d3d-ATL")
try:
    with urllib.request.urlopen(req) as r:
        st, body = r.status, r.read().decode()
except urllib.error.HTTPError as e:
    st, body = e.code, e.read().decode()
check("a request carrying Cf-Ray is refused (401), not signed in", st == 401, f"got {st}")
check("the refusal leaks no roster data", "Marcus Canary" not in body)

# And without it, local development still works -- otherwise the guard is
# "secure" by way of being broken, which is how the last two versions passed
# review.
st, _ = call("GET", ADMIN + "/")
check("without Cf-Ray, local dev still signs in", st == 200, f"got {st}")

print("\n=== 9. a forged Access assertion grants nothing ===")
req = urllib.request.Request(BASE + "/api/admin/registrations", method="GET")
req.add_header("Cf-Access-Jwt-Assertion", "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImF0dGFja2VyQGV2aWwuY29tIn0.")
try:
    with urllib.request.urlopen(req) as r:
        st = r.status
except urllib.error.HTTPError as e:
    st = e.code
check("forged assertion does not unlock the token-protected export", st == 401, f"got {st}")

set_role("admin")

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
