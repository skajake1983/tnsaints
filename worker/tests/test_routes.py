"""Golden routes: what every admin route answers, for every role (admin/router.js).

A characterization test. It walks each admin route as an admin, a coach and a
viewer and records what comes back -- status, kind (html / json / redirect and
where to), and whether the page carries a script CSP -- then compares with
tests/golden_routes.json. It was recorded BEFORE the router was split into a
route table, so the split had to reproduce the old behaviour exactly; any later
change to who can reach what shows up here as a diff to explain.

Requests are chosen to reach each route's permission check without doing
anything lasting: unknown ids, empty or invalid bodies.

    python tests/test_routes.py            compare with the golden file
    python tests/test_routes.py --record   rewrite it (then review the diff!)
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import wrangler_local
from _harness import preflight, staff_email

BASE = "http://127.0.0.1:8787"
ADMIN = "/__admin"
GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden_routes.json")
preflight(BASE)
ME = staff_email()
ROLES = ["admin", "coach", "viewer", "board"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FORM = "form"
JSON = "json"

# (method, path, body kind, body)
ROUTES = [
    ("GET", "/", None, None),
    ("GET", "/profile", None, None),
    ("GET", "/logo.png", None, None),
    ("GET", "/no-such-page", None, None),
    ("GET", "/privacy", None, None),
    ("POST", "/privacy/999999/verified", FORM, {}),
    ("GET", "/brief", None, None),
    ("GET", "/inbox", None, None),
    ("GET", "/inbox?status=handled", None, None),
    ("POST", "/inbox/999999/handled", FORM, {}),
    ("GET", "/billing", None, None),
    ("POST", "/billing/import", FORM, {"subscription_id": "not-an-id"}),
    ("POST", "/billing/999999/sync", FORM, {}),
    ("POST", "/billing/999999/link", FORM, {}),
    ("GET", "/families", None, None),
    ("POST", "/families/invite", FORM, {"email": "not an email"}),
    ("GET", "/families/children/999999/medical", None, None),
    ("GET", "/programs/academy", None, None),
    ("GET", "/programs/no-such-program", None, None),
    ("POST", "/programs/academy/groups/999999", FORM, {}),
    ("GET", "/enrollments", None, None),
    ("POST", "/enrollments/999999/offer", FORM, {"group_id": "1"}),
    ("POST", "/enrollments/999999/waitlist", FORM, {}),
    ("POST", "/enrollments/999999/decline", FORM, {"reason": "not-a-reason"}),
    ("GET", "/users", None, None),
    ("POST", "/api/staff", JSON, {}),
    ("POST", "/api/staff/deactivate", JSON, {}),
    ("POST", "/api/staff/activate", JSON, {}),
    ("POST", "/api/staff/reinvite", JSON, {"email": "nobody@example.com"}),
    ("GET", "/api/roster", None, None),
    ("GET", "/api/health", None, None),
    ("GET", "/api/roster/999999/medical", None, None),
    ("GET", "/eval", None, None),
    ("GET", "/eval/999999", None, None),
    ("POST", "/api/eval/999999", JSON, {}),
    ("POST", "/api/eval/999999/author/delete", JSON, {}),
    ("POST", "/api/decision/999999", JSON, {}),
    ("GET", "/decisions", None, None),
    ("POST", "/api/batch/no-such-batch/approve", JSON, {}),
    ("POST", "/api/batch/no-such-batch/reopen", JSON, {}),
    ("POST", "/api/batch/no-such-batch/replace", JSON, {}),
    ("GET", "/api/batch/no-such-batch/preflight", None, None),
    ("POST", "/api/batch/no-such-batch/send", JSON, {}),
    ("POST", "/api/registration/999999/cancel", JSON, {}),
    ("POST", "/api/registration/999999/delete", JSON, {}),
    ("POST", "/api/message/999999/review", JSON, {}),
    ("POST", "/api/message/999999/edit", JSON, {"body_text": ""}),
    ("GET", "/api/message/999999/preview", None, None),
    # Wrong method on a real path: falls through to the not-found page.
    ("DELETE", "/users", None, None),
    # The CRM screens (C1).
    ("GET", "/crm", None, None),
    ("GET", "/crm?pipeline=sponsor", None, None),
    ("GET", "/crm/list", None, None),
    ("GET", "/crm/list.csv", None, None),
    ("GET", "/crm/tasks", None, None),
    ("GET", "/crm/customers", None, None),
    ("GET", "/crm/contacts/new", None, None),
    ("POST", "/crm/contacts/new", FORM, {}),
    ("GET", "/crm/contacts/999999", None, None),
    ("GET", "/crm/families/999999", None, None),
    ("GET", "/crm/import", None, None),
    ("POST", "/crm/cards/999999/move", FORM, {"stage": "contacted"}),
    ("POST", "/crm/contacts/999999/activity", FORM, {"kind": "call"}),
    ("POST", "/crm/contacts/999999/merge", FORM, {"into_id": "1"}),
    ("POST", "/crm/families/999999/owner", FORM, {"owner": ""}),
    ("POST", "/crm/tasks", FORM, {"title": ""}),
    ("POST", "/crm/tasks/999999/done", FORM, {}),
    # Privacy and safety (S1).
    ("POST", "/privacy/retention/check", FORM, {}),
    ("POST", "/privacy/holds", FORM, {"subject_type": "household", "subject_id": "999999", "reason": "Test"}),
    ("POST", "/privacy/holds/999999/release", FORM, {}),
    ("GET", "/clearances", None, None),
    ("POST", "/clearances", FORM, {}),
    ("GET", "/clearances/person?email=nobody%40example.com", None, None),
    ("POST", "/clearances/999999/revoke", FORM, {}),
    # Programs manager (G1).
    ("GET", "/programs", None, None),
    ("POST", "/programs/new", FORM, {}),
    ("POST", "/programs/academy/details", FORM, {}),
    ("POST", "/programs/academy/current", FORM, {"current": "on"}),
    ("GET", "/enrollments?program=no-such-program", None, None),
    ("GET", "/teams", None, None),
    ("GET", "/teams/999999", None, None),
    ("POST", "/teams/999999/coaches", FORM, {"email": "x@example.com", "role": "head"}),
    ("POST", "/teams/999999/events", FORM, {}),
    ("POST", "/teams/999999/calendar/rotate", FORM, {}),
    # Governance (N1).
    ("GET", "/board", None, None),
    ("GET", "/board/members", None, None),
    ("POST", "/board/members", FORM, {}),
    ("POST", "/board/members/999999/end", FORM, {}),
    ("GET", "/board/meetings", None, None),
    ("POST", "/board/meetings", FORM, {}),
    ("GET", "/board/meetings/999999", None, None),
    ("POST", "/board/meetings/999999/attendance", FORM, {}),
    ("POST", "/board/meetings/999999/motions/999999/votes", FORM, {}),
    ("POST", "/board/meetings/999999/minutes/approve", FORM, {}),
    ("POST", "/board/actions/999999/done", FORM, {}),
    ("GET", "/board/documents", None, None),
    ("POST", "/board/documents", FORM, {}),
    ("POST", "/board/documents/999999/archive", FORM, {}),
    ("GET", "/board/compliance", None, None),
    ("POST", "/board/compliance", FORM, {}),
    ("POST", "/board/compliance/999999/done", FORM, {}),
    ("GET", "/board/disclosures", None, None),
    ("POST", "/board/disclosures", FORM, {}),
    # Donations (D1).
    ("GET", "/donations", None, None),
    ("POST", "/donations", FORM, {}),
    ("POST", "/donations/settings", FORM, {}),
    ("GET", "/donations/999999", None, None),
    ("POST", "/donations/999999/receipt", FORM, {}),
    ("GET", "/donations/summary", None, None),
]

# What the board role may reach. Everything else -- every roster, family, CRM,
# program, team, billing and privacy route -- must refuse it (checked below).
BOARD_REACHES = ("/board", "/donations", "/profile", "/api/health", "/logo.png", "/no-such-page", "/")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def hit(method, path, kind, body):
    data = None
    req = urllib.request.Request(BASE + ADMIN + path, method=method)
    if kind == JSON:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    elif kind == FORM:
        data = urllib.parse.urlencode(body).encode()
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if method != "GET":
        req.add_header("Sec-Fetch-Site", "same-origin")
    req.data = data
    try:
        r = _OPENER.open(req)
    except urllib.error.HTTPError as e:
        r = e
    status = getattr(r, "status", None) or r.code
    headers = {k.lower(): v for k, v in r.headers.items()}
    r.read()
    ctype = headers.get("content-type", "")
    if 300 <= status < 400:
        loc = headers.get("location", "")
        shape = "redirect " + (loc[len(ADMIN):] if loc.startswith(ADMIN) else loc)
    elif ctype.startswith("application/json"):
        shape = "json"
    elif ctype.startswith("text/html"):
        shape = "html"
    else:
        shape = ctype.split(";")[0] or "none"
    csp = headers.get("content-security-policy", "")
    script = "script" if "script-src" in csp and "'sha256-" in csp else "no-script"
    return [status, shape, script]


import urllib.parse  # noqa: E402  (used by hit)


def record():
    out = {}
    for role in ROLES:
        wrangler_local(f"UPDATE staff SET role='{role}' WHERE email_norm='{ME}'")
        for method, path, kind, body in ROUTES:
            out.setdefault(f"{method} {path}", {})[role] = hit(method, path, kind, body)
    wrangler_local(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")
    return out


wrangler_local("DELETE FROM staff")
wrangler_local("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
               f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

seen = record()

if "--record" in sys.argv:
    with open(GOLDEN, "w", encoding="utf-8") as f:
        json.dump(seen, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"recorded {len(seen)} routes x {len(ROLES)} roles -> {GOLDEN}")
    sys.exit(0)

with open(GOLDEN, encoding="utf-8") as f:
    golden = json.load(f)

passed, failed = [], []
print("\n=== every admin route answers as recorded, for every role ===")
for key in sorted(set(golden) | set(seen)):
    for role in ROLES:
        want = golden.get(key, {}).get(role)
        got = seen.get(key, {}).get(role)
        if want == got:
            passed.append((key, role))
        else:
            failed.append((key, role))
            print(f"  FAIL  {key} as {role}: expected {want}, got {got}")
print(f"  PASS  {len(passed)} of {len(passed) + len(failed)} route/role answers unchanged")

print("\n=== the board role reaches no child data ===")
leaks = []
for key, answers in sorted(seen.items()):
    path = key.split(" ", 1)[1].split("?")[0]
    if path == "/" or any(path == p or path.startswith(p + "/") for p in BOARD_REACHES if p != "/"):
        continue
    # Refused (403), or no such route at all (404): either way, nothing shown.
    if answers.get("board", [0])[0] not in (403, 404):
        leaks.append((key, answers.get("board")))
(failed if leaks else passed).append(("board refused everywhere else", ""))
print(f"  {'FAIL' if leaks else 'PASS'}  every other admin route refuses a board member (403/404)" + (f"   {leaks[:5]}" if leaks else ""))
home = seen.get("GET /", {}).get("board")
(passed if home and home[0] == 303 and home[1] == "redirect /board" else failed).append(("board home", ""))
print(f"  {'PASS' if home and home[1] == 'redirect /board' else 'FAIL'}  a board member's home is the board, not the roster   {home}")


def unit(label, cond, detail=""):
    (passed if cond else failed).append((label, ""))
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond or not detail else f"   {detail}"))


print("\n=== every menu link names its page's capability (admin/nav.js) ===")
import subprocess  # noqa: E402
NAVCHECK = r"""
import { matchRoute } from './src/admin/routes/index.js';
import { NAV } from './src/admin/nav.js';
const wrong = NAV.filter((n) => matchRoute('GET', n.href)?.route.cap !== n.cap).map((n) => n.href);
console.log(JSON.stringify(wrong));
"""
_worker = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_out = subprocess.run(["node", "--input-type=module", "-e", NAVCHECK], cwd=_worker, capture_output=True, text=True)
_wrong = json.loads(_out.stdout.strip() or "null") if _out.returncode == 0 else None
(passed if _wrong == [] else failed).append(("nav caps", ""))
print(f"  {'PASS' if _wrong == [] else 'FAIL'}  each menu link shows only to those its page admits   {_wrong if _wrong else _out.stderr[-300:]}")

print("\n=== the route table fails closed, at load (admin/routes/index.js) ===")
UNIT = r"""
import { ROUTES, validateRoutes, matchRoute } from './src/admin/routes/index.js';
const h = () => new Response('');
const tries = {
  missing: { method: 'GET', path: '/x', handler: h },
  typo: { method: 'GET', path: '/x', cap: 'roster:veiw', handler: h },
  method: { method: 'PUT', path: '/x', cap: 'staff', handler: h },
  noHandler: { method: 'GET', path: '/x', cap: 'staff' },
};
const refused = {};
for (const [k, r] of Object.entries(tries)) {
  try { validateRoutes([r]); refused[k] = false; } catch { refused[k] = true; }
}
let twice = false;
try { validateRoutes([{ method: 'GET', path: '/x', cap: 'staff', handler: h }, { method: 'GET', path: '/x', cap: 'staff', handler: h }]); }
catch { twice = true; }
const capOf = (m, p) => matchRoute(m, p)?.route.cap ?? null;
console.log(JSON.stringify({
  count: ROUTES.length, refused, twice,
  open: ROUTES.filter((r) => r.cap === 'staff').map((r) => `${r.method} ${r.path}`),
  roster: [capOf('GET', '/'), capOf('GET', '/api/roster'), capOf('GET', '/api/roster/5/medical'), capOf('GET', '/families')],
  none: [capOf('GET', '/nope'), capOf('PUT', '/users')],
}));
"""
import subprocess  # noqa: E402

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
unit("unit harness ran", u is not None, (res.stderr or b"").decode()[-300:])
if u:
    unit("a route with no capability, a misspelled one, a method other than GET/POST, or no handler will not load",
         all(u["refused"].values()), u["refused"])
    unit("nor will the same route declared twice", u["twice"])
    unit("only the profile and health check are open to any signed-in staff member",
         sorted(u["open"]) == ["GET /api/health", "GET /profile"], u["open"])
    unit("the roster page and its JSON need roster:view; the medical read needs roster:medical",
         u["roster"] == ["roster:view", "roster:view", "roster:medical", "roster:view"], u["roster"])
    unit("an unknown path or method matches nothing (the 404 page)", u["none"] == [None, None], u["none"])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
print("=" * 62)
sys.exit(1 if failed else 0)
