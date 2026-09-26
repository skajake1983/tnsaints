"""Cross-site request protection on the admin surface (src/lib/csrf.js).

A signed-in coach who visits any other website must not be made to change
anything here. The browser attaches their Cloudflare Access cookie to a forged
POST, so authentication alone cannot tell the difference; Sec-Fetch-Site can.

Asserted in the direction that matters: forged requests change nothing and are
audited, and every request our own pages actually make still works. Deleting
the check in admin/router.js makes this suite fail.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import wrangler_local
from _harness import preflight, staff_email

BASE = "http://127.0.0.1:8787"
preflight(BASE)

ADMIN = "/__admin"
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


def sql(command):
    return wrangler_local(command)


def count(query):
    m = re.search(r'"n":\s*(\d+)', sql(query))
    return int(m.group(1)) if m else -1


def call(method, path, body=None, headers=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


# --- setup: one staff admin, one registration to write evaluations against ----
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("DELETE FROM audit_log")

call("POST", "/api/register", {
    "session_time": "9:00 AM", "player_name": "Csrf Kid", "grade": "5th",
    "years_experience": 2, "parent_name": "Parent of Csrf Kid",
    "parent_email": "csrf@example.com", "phone": "(615) 555-0100",
    "school": "Franklin Elementary", "emergency_contact_name": "EC",
    "emergency_contact_phone": "(615) 555-0199", "medical_notes": "",
    "player_notes": "A normal note for the CSRF tests.",
    "assumption_of_risk": True, "medical_release": True, "photo_release": True,
    "signature": "Parent Test", "turnstile_token": "d", "elapsed_ms": 9000,
}, headers={"Origin": "https://tnsaints.com", "CF-Connecting-IP": "10.71.0.1"})
m = re.search(r'"id":\s*(\d+)', sql("SELECT id FROM registrations WHERE player_name='Csrf Kid'"))
RID = int(m.group(1)) if m else None
check("setup: a registration exists", RID is not None)

EVAL = f"{ADMIN}/api/eval/{RID}"
NOTES = f"SELECT COUNT(*) AS n FROM eval_feedback WHERE registration_id={RID}"
BLOCKED = "SELECT COUNT(*) AS n FROM audit_log WHERE action='admin.csrf_blocked'"


def save(marker, headers):
    return call("POST", EVAL, {"strengths": f"{marker} competed hard.", "growth_area": "Left hand."}, headers)


print("\n=== Forged requests: refused, nothing written, audited ===")
for site in ("cross-site", "same-site", "none", "bogus-value"):
    before = count(NOTES)
    st, body = save(f"FORGED-{site}", {"Sec-Fetch-Site": site})
    check(f"Sec-Fetch-Site: {site} is refused with 403", st == 403, f"got {st} {str(body)[:120]}")
    check(f"  ...with a JSON error the page can show",
          isinstance(body, dict) and body.get("ok") is False and "admin site" in body.get("error", ""),
          str(body)[:160])
    check(f"  ...and nothing was saved", count(NOTES) == before)

forged_text = sql(f"SELECT COUNT(*) AS n FROM eval_feedback WHERE strengths LIKE 'FORGED%'")
check("no forged evaluation text reached the database", '"n": 0' in forged_text, forged_text[-120:])

st, body = save("SAMESITE-WITH-ORIGIN", {"Sec-Fetch-Site": "same-site", "Origin": "https://admin.tnsaints.com"})
check("a correct Origin cannot rescue a failing Sec-Fetch-Site", st == 403, f"got {st}")

log = sql("SELECT actor, action, detail FROM audit_log WHERE action='admin.csrf_blocked' ORDER BY id")
check("every refusal is audited", count(BLOCKED) == 5, log[-400:])
check("the audit names the reason", "sec-fetch-site:cross-site" in log and "sec-fetch-site:other" in log, log[-400:])
check("the audit never echoes an unrecognised header value", "bogus-value" not in log)
check("the audit holds no submitted text", "FORGED" not in log)

print("\n=== Our own pages still work ===")
before = count(NOTES)
st, body = save("SAME-ORIGIN", {"Sec-Fetch-Site": "same-origin", "Origin": "https://admin.tnsaints.com"})
check("Sec-Fetch-Site: same-origin is accepted", st == 200 and body.get("ok"), f"got {st} {str(body)[:160]}")

st, body = save("NULL-ORIGIN-FORM", {"Sec-Fetch-Site": "same-origin", "Origin": "null"})
check("a same-origin form POST with Origin: null (Referrer-Policy: no-referrer) is accepted",
      st == 200 and body.get("ok"), f"got {st} {str(body)[:160]}")

st, body = save("NO-HEADERS", {})
check("a client sending neither header still works (report mode)", st == 200 and body.get("ok"), f"got {st}")

st, body = save("FOREIGN-ORIGIN", {"Origin": "https://evil.example"})
check("a foreign Origin without Sec-Fetch-Site is only reported for now (ADMIN_CSRF_MODE=report)",
      st == 200, f"got {st}")
check("report mode writes no audit rows", count(BLOCKED) == 5)

print("\n=== Safe methods and ordering ===")
st, _ = call("GET", ADMIN + "/", headers={"Sec-Fetch-Site": "cross-site"})
check("a cross-site GET (a link from an email or another site) still opens the roster", st == 200, f"got {st}")

sql(f"UPDATE staff SET active=0 WHERE email_norm='{ME}'")
st, body = save("NOT-STAFF", {"Sec-Fetch-Site": "cross-site"})
check("a non-staff principal still gets the not-authorised 403, not the CSRF one",
      st == 403 and "admin site" not in str(body), f"got {st} {str(body)[:120]}")
sql(f"UPDATE staff SET active=1 WHERE email_norm='{ME}'")

print("\n=== The check itself (src/lib, imported directly) ===")
UNIT = r"""
import { crossSiteCheck, isLoopbackOrigin } from './src/lib/csrf.js';
import { flag, choice } from './src/lib/flags.js';
import { adminOriginAllowed } from './src/admin/router.js';
const allow = { isAllowedOrigin: (o) => o === 'https://admin.tnsaints.com' };
const env = { ADMIN_HOSTNAME: 'admin.tnsaints.com' };
const devUrl = 'http://api.tnsaints.com/__admin/api/eval/1';   // what wrangler dev reports
const prodUrl = 'https://admin.tnsaints.com/api/eval/1';
const ao = (origin, requestUrl, isDev) => adminOriginAllowed(origin, { env, requestUrl, isDev });
const req = (method, h) => new Request('https://admin.tnsaints.com/api/x', { method, headers: h });
const out = {
  post_cross: crossSiteCheck(req('POST', { 'Sec-Fetch-Site': 'cross-site' }), allow),
  post_same: crossSiteCheck(req('POST', { 'Sec-Fetch-Site': 'same-origin' }), allow),
  put_cross: crossSiteCheck(req('PUT', { 'Sec-Fetch-Site': 'cross-site' }), allow),
  delete_cross: crossSiteCheck(req('DELETE', { 'Sec-Fetch-Site': 'cross-site' }), allow),
  get_cross: crossSiteCheck(req('GET', { 'Sec-Fetch-Site': 'cross-site' }), allow),
  no_headers: crossSiteCheck(req('POST', {}), allow),
  null_origin: crossSiteCheck(req('POST', { Origin: 'null' }), allow),
  good_origin: crossSiteCheck(req('POST', { Origin: 'https://admin.tnsaints.com' }), allow),
  suffix_origin: crossSiteCheck(req('POST', { Origin: 'https://admin.tnsaints.com.evil.example' }), allow),
  loop_ok: isLoopbackOrigin('http://127.0.0.1:8787') && isLoopbackOrigin('http://localhost:3000'),
  loop_bad: isLoopbackOrigin('http://127.0.0.1.evil.example') || isLoopbackOrigin('garbage') || isLoopbackOrigin('file://localhost'),
  mode_unset: choice({}, 'M', ['report', 'enforce'], 'enforce'),
  mode_typo: choice({ M: 'Report' }, 'M', ['report', 'enforce'], 'enforce'),
  mode_ok: choice({ M: 'report' }, 'M', ['report', 'enforce'], 'enforce'),
  flag_strict: [flag({ F: 'true' }, 'F', false), flag({ F: true }, 'F', false), flag({ F: 'True' }, 'F', false),
                flag({ F: 'yes' }, 'F', false), flag({ F: '1' }, 'F', false), flag({ F: 'false' }, 'F', true),
                flag({}, 'F', true)],
  admin_prod_ok: ao('https://admin.tnsaints.com', prodUrl, false),
  admin_prod_refuses: [ao('http://admin.tnsaints.com', prodUrl, false), ao('https://api.tnsaints.com', prodUrl, false),
                       ao('https://tnsaints.com', prodUrl, false), ao('http://127.0.0.1:8787', prodUrl, false),
                       ao('https://admin.tnsaints.com.evil.example', prodUrl, false)],
  admin_dev_ok: [ao('http://api.tnsaints.com', devUrl, true), ao('http://localhost:8787', devUrl, true),
                 ao('https://admin.tnsaints.com', devUrl, true)],
  admin_dev_refuses: [ao('https://evil.example', devUrl, true), ao('https://tnsaints.com', devUrl, true)],
  admin_unconfigured: adminOriginAllowed('https://admin.tnsaints.com', { env: {}, requestUrl: prodUrl, isDev: false }),
};
console.log(JSON.stringify(out));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True,
                     shell=False, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-300:])
if u:
    check("POST cross-site fails at the fetch-metadata layer",
          u["post_cross"] == {"ok": False, "layer": "fetch-metadata", "reason": "sec-fetch-site:cross-site"},
          u["post_cross"])
    check("POST same-origin passes", u["post_same"] == {"ok": True})
    check("PUT and DELETE are checked like POST",
          not u["put_cross"]["ok"] and not u["delete_cross"]["ok"])
    check("GET is never blocked", u["get_cross"] == {"ok": True})
    check("no headers fails at the origin layer (reportable)",
          u["no_headers"] == {"ok": False, "layer": "origin", "reason": "no-origin"}, u["no_headers"])
    check("Origin: null without Sec-Fetch-Site fails", u["null_origin"]["reason"] == "null-origin")
    check("the exact admin origin passes", u["good_origin"] == {"ok": True})
    check("a look-alike origin that merely starts with ours fails", u["suffix_origin"]["ok"] is False)
    check("loopback origins are recognised", u["loop_ok"] is True)
    check("look-alike and malformed loopback origins are not", u["loop_bad"] is False)
    check("an unset ADMIN_CSRF_MODE enforces", u["mode_unset"] == "enforce")
    check("a misspelled ADMIN_CSRF_MODE enforces", u["mode_typo"] == "enforce")
    check("'report' is read as report", u["mode_ok"] == "report")
    check("flags accept only exact true/false", u["flag_strict"] == [True, True, False, False, False, False, True],
          u["flag_strict"])
    check("production accepts exactly https://<ADMIN_HOSTNAME>", u["admin_prod_ok"] is True)
    check("production refuses http, sibling hosts, the marketing site, loopback and look-alikes",
          u["admin_prod_refuses"] == [False] * 5, u["admin_prod_refuses"])
    check("local dev accepts the origin wrangler rewrites the browser's to, and loopback",
          u["admin_dev_ok"] == [True] * 3, u["admin_dev_ok"])
    check("local dev still refuses foreign origins", u["admin_dev_refuses"] == [False] * 2, u["admin_dev_refuses"])
    check("no ADMIN_HOSTNAME configured means no origin is trusted", u["admin_unconfigured"] is False)

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
sys.exit(1 if failed else 0)
