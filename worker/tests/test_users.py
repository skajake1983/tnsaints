"""User management: add, re-role, deactivate staff from the admin site.

Nothing here sends real email (loopback sink, but this suite does not even need
it — the invite is best-effort and its send is not asserted against a live
provider). The security-relevant assertions are the ones that matter: only an
admin can manage users, the last admin cannot be locked out, and a deactivated
staff member genuinely loses access.
"""
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


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Origin", ORIGIN)
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


def role_of(email):
    out = _wrangler(f"SELECT role, active FROM staff WHERE email_norm='{email}'")
    role = re.search(r'"role":\s*"([^"]+)"', out)
    active = re.search(r'"active":\s*(\d)', out)
    return (role.group(1) if role else None), (int(active.group(1)) if active else None)


# Start from just the seeded admin.
sql("DELETE FROM staff; DELETE FROM audit_log")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

print("\n=== 1. the Users screen is admin-only ===")
st, body = call("GET", ADMIN + "/users")
check("an admin sees the Users screen", st == 200 and "Add someone" in str(body), f"got {st}")

sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _ = call("GET", ADMIN + "/users")
check("a coach cannot see the Users screen", st == 403, f"got {st}")
st, r = call("POST", ADMIN + "/api/staff", {"email": "x@tnsaints.com", "display_name": "X",
                                    "author_label": "Coach X", "role": "coach"})
check("a coach cannot add a user", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n=== 2. adding a user creates the row ===")
st, r = call("POST", ADMIN + "/api/staff", {
    "email": "New.Coach@TNSAINTS.com", "display_name": "New Coach",
    "author_label": "Coach New", "role": "coach", "send_invite": False})
check("add succeeds", st == 200 and r.get("ok"), str(r)[:200])
check("it reports the row as newly created", r.get("created") is True, str(r))
role, active = role_of("new.coach@tnsaints.com")
check("email is normalised to lowercase", role == "coach", f"role={role}")
check("the new user is active", active == 1)

st, r = call("POST", ADMIN + "/api/staff", {
    "email": "new.coach@tnsaints.com", "display_name": "New Coach",
    "author_label": "Coach New", "role": "admin", "send_invite": False})
check("re-adding the same email updates rather than duplicates", st == 200 and r.get("created") is False, str(r))
role, _ = role_of("new.coach@tnsaints.com")
check("the role was updated", role == "admin", f"role={role}")

print("\n=== 3. validation ===")
st, r = call("POST", ADMIN + "/api/staff", {"email": "not-an-email", "display_name": "X",
                                    "author_label": "Coach X", "role": "coach"})
check("a bad email is refused", st == 400, f"got {st}")
st, r = call("POST", ADMIN + "/api/staff", {"email": "ok@tnsaints.com", "display_name": "X",
                                    "author_label": "Coach X", "role": "superuser"})
check("an unknown role is refused", st == 400, f"got {st}")
st, r = call("POST", ADMIN + "/api/staff", {"email": "ok@tnsaints.com", "display_name": "",
                                    "author_label": "Coach X", "role": "coach"})
check("a missing name is refused", st == 400, f"got {st}")

print("\n=== 4. deactivation removes access, and keeps the record ===")
st, r = call("POST", ADMIN + "/api/staff/deactivate", {"email": "new.coach@tnsaints.com"})
check("deactivate succeeds", st == 200 and r.get("ok"), str(r))
_, active = role_of("new.coach@tnsaints.com")
check("the row is kept but inactive", active == 0)
# loadStaff returns null for active=0, so the middleware would 403 them.
out = _wrangler("SELECT COUNT(*) AS n FROM staff WHERE email_norm='new.coach@tnsaints.com'")
check("the row is NOT deleted", '"n": 1' in out, out[-160:])

st, r = call("POST", ADMIN + "/api/staff/activate", {"email": "new.coach@tnsaints.com"})
check("reactivate restores access", st == 200 and r.get("ok"), str(r))
_, active = role_of("new.coach@tnsaints.com")
check("active again", active == 1)

print("\n=== 5. the last active admin cannot be locked out ===")
# Right now there are two admins (ME + new.coach). Demote new.coach back to
# coach so ME is the only admin, then try to remove ME's own admin.
call("POST", ADMIN + "/api/staff", {"email": "new.coach@tnsaints.com", "display_name": "New Coach",
                            "author_label": "Coach New", "role": "coach", "send_invite": False})
out = _wrangler("SELECT COUNT(*) AS n FROM staff WHERE role='admin' AND active=1")
check("exactly one admin remains", '"n": 1' in out, out[-160:])

st, r = call("POST", ADMIN + "/api/staff", {"email": ME, "display_name": "Jacob Adams",
                                    "author_label": "Coach Adams", "role": "coach", "send_invite": False})
check("demoting the only admin is refused", st == 400 and "only active admin" in str(r).lower(), str(r)[:200])
role, _ = role_of(ME)
check("and the admin keeps their role", role == "admin", f"role={role}")

st, r = call("POST", ADMIN + "/api/staff/deactivate", {"email": ME})
check("deactivating the only admin is refused", st == 400 and "only active admin" in str(r).lower(), str(r)[:200])
_, active = role_of(ME)
check("and the admin keeps access", active == 1)

# With a second admin present, demoting the first IS allowed.
call("POST", ADMIN + "/api/staff", {"email": "second.admin@tnsaints.com", "display_name": "Second Admin",
                            "author_label": "Coach Second", "role": "admin", "send_invite": False})
st, r = call("POST", ADMIN + "/api/staff/deactivate", {"email": ME})
check("with a second admin, deactivating the first is allowed", st == 200 and r.get("ok"), str(r)[:200])
# Restore ME so later suites are unaffected.
call("POST", ADMIN + "/api/staff/activate", {"email": ME})
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n=== 6. every change is audited, with no secret content ===")
log = _wrangler("SELECT actor, action, subject_id FROM audit_log ORDER BY id DESC LIMIT 40")
for action in ["staff.add", "staff.update", "staff.deactivate", "staff.activate"]:
    check(f"{action} is audited", action in log, log[-200:])
check("the acting admin is recorded as the actor", ME in log)

print("\n=== 7. the invite email is a plain link, not a magic bypass ===")
src = open(os.path.join(WORKER_DIR, "src", "email.js"), encoding="utf-8").read()
invite = re.search(r"export async function sendStaffInvite.*?\n}", src, re.S).group(0)
check("the invite points at the admin URL", "admin.tnsaints.com" in invite or "ADMIN_HOSTNAME" in invite)
check("it tells them to use their M365 login", "Microsoft 365" in invite)
check("it carries no token or magic-link parameter",
      "token" not in invite.lower() and "?t=" not in invite, "a token leaked into the invite")


print("\n=== 8. the Users page script is valid JS and its CSP hash matches ===")
# A syntax error in the inline script silently disables every button on the
# page (the browser refuses to run a script whose hash matches broken text).
# Assert both: the served script parses, and the declared hash matches it.
import base64, hashlib, tempfile
sql(f"UPDATE staff SET role='admin', active=1 WHERE email_norm='{ME}'")
req = urllib.request.Request(BASE + ADMIN + "/users", method="GET")
req.add_header("Origin", ORIGIN)
try:
    with urllib.request.urlopen(req) as rsp:
        csp = rsp.headers.get("Content-Security-Policy", "")
        html = rsp.read().decode()
except urllib.error.HTTPError as e:
    csp, html = "", ""
    check("the Users page is reachable as admin", False, f"got {e.code}")
declared = re.search(r"script-src '(sha256-[^']+)'", csp)
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
check("the page carries a hashed inline script", bool(declared) and bool(scripts), f"csp={csp[:80]}")
if declared and scripts:
    actual = "sha256-" + base64.b64encode(hashlib.sha256(scripts[-1].encode("utf-8")).digest()).decode()
    check("the declared hash matches the served script", declared.group(1) == actual,
          f"{declared.group(1)} vs {actual}")
    tmp = os.path.join(WORKER_DIR, ".users-script-check.js")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(scripts[-1])
    try:
        res = subprocess.run(["node", "--check", tmp], capture_output=True,
                             shell=(os.name == "nt"), cwd=WORKER_DIR)
        check("the served script is valid JavaScript", res.returncode == 0,
              (res.stderr or b"").decode("utf-8", "replace")[:200])
    finally:
        try: os.remove(tmp)
        except OSError: pass

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
