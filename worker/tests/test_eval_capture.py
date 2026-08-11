"""Coach evaluation capture: attribution, upsert, and the internal/parent split.

The load-bearing test here is the CANARY: an internal note must never be
reachable from anything that composes a message to a family. That is the single
failure this whole two-table design exists to prevent, and it is unrecoverable
-- there is no apology that repairs sending a coach's candid assessment to the
child's parents.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email


BASE = "http://127.0.0.1:8787"
preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(WORKER_DIR, "src")

# From .dev.vars -- this repo is public, so real staff addresses stay out of it.
ME = staff_email()
COACH = "second.coach@example.com"

INTERNAL_CANARY = "INTERNAL-CANARY-NEVER-SEND-XYZ"

passed, failed = [], []


# Windows consoles default to cp1252, and wrangler's output contains emoji.
# Without this, a FAILING assertion crashes while printing its own diagnostic --
# so the run dies with a UnicodeEncodeError instead of telling you what broke.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    if cond or not detail:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    else:
        safe = str(detail).encode("ascii", "replace").decode("ascii")
        print(f"  FAIL  {label}   {safe}")


def _wrangler(command):
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "tnsaints", "--local", "--command", command],
        capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR,
    )
    return (res.stdout or b"").decode("utf-8", errors="replace")


def sql(command):
    _wrangler(command)


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


def register(name, n):
    return call("POST", "/api/register", {
        "session_time": "9:00 AM", "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": f"Parent {name}",
        "parent_email": f"evalcap{n}@example.com", "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Registration created for evaluation capture tests.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "d",
    })


def set_role(role, email=ME):
    sql(f"UPDATE staff SET role='{role}' WHERE email_norm='{email}'")


def reg_id(name):
    out = _wrangler(
        f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1"
    )
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


print("\n=== setup ===")
# Child-first. D1 enforces foreign keys, so deleting registrations while notes
# reference them fails -- and a failed cleanup is worse than none, because the
# suite then silently runs against the previous run's data.
sql("DELETE FROM eval_notes_internal")
sql("DELETE FROM eval_feedback")
sql("DELETE FROM registrations")
sql("DELETE FROM players")
sql("DELETE FROM audit_log")
sql("DELETE FROM email_budget")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{COACH}', 'Brandon Turner', 'Coach Turner', 'coach', 1, datetime('now'), datetime('now'))")

leftover = _wrangler("SELECT COUNT(*) AS n FROM registrations")
check("cleanup actually emptied the table", '"n": 0' in leftover, leftover[-200:])

st, _ = register("Marcus Reed", 1)
check("registration created", st == 200, f"got {st}")
RID = reg_id("Marcus Reed")
check("registration id resolved", RID is not None)

print("\n=== 1. the capture surface loads ===")
st, body = call("GET", ADMIN + "/eval")
check("player list is 200", st == 200, f"got {st}")
check("list shows players needing notes", "no notes" in str(body))
st, body = call("GET", f"{ADMIN}/eval/{RID}")
check("evaluation form is 200", st == 200, f"got {st}")
check("form warns which box families never see",
      "Never sent to families" in str(body), "missing the internal-block warning")

print("\n=== 2. saving, and the internal/parent split at rest ===")
st, r = call("POST", f"{ADMIN}/api/eval/{RID}", {
    "rating_skill": 4, "rating_effort": 5, "rating_coachability": 4, "rating_decisions": 3,
    "strengths": "Kept his head up in transition and found the trailer twice.",
    "growth_area": "Left hand under pressure.",
    "parent_note": "A pleasure to coach.",
    "internal_note": INTERNAL_CANARY + " candid assessment goes here",
})
check("save succeeds", st == 200 and r.get("ok"), str(r))

parent_table = _wrangler("SELECT * FROM eval_feedback")
internal_table = _wrangler("SELECT * FROM eval_notes_internal")
# The invariant: eval_feedback is safe to SELECT * and hand to a composer.
check("the parent-facing table contains NO internal note",
      INTERNAL_CANARY not in parent_table)
check("the internal note is stored, just elsewhere", INTERNAL_CANARY in internal_table)

print("\n=== 3. THE CANARY: no parent-facing path can reach an internal note ===")
# parentFacingFeedback() is the only data accessor a composer is permitted to
# import. Asserting on its source is deliberate: the composer does not exist
# yet, and this is the guard that has to already be true on the day it is
# written, not a test added alongside it.
notes_src = open(os.path.join(SRC, "feedback", "notes.js"), encoding="utf-8").read()
m = re.search(r"export async function parentFacingFeedback\(.*?\n}", notes_src, re.S)
check("parentFacingFeedback() exists", m is not None)
if m:
    fn = m.group(0)
    check("it never references the internal table", "eval_notes_internal" not in fn, fn[:200])
    check("it reads only eval_feedback", "eval_feedback" in fn)

def strip_comments(js):
    """Remove block and line comments.

    The canary must judge CODE, not prose. compose.js documents at length that
    it cannot reach the internal table -- naming it to say so -- and a raw
    substring search failed on exactly that sentence. A test that forces you to
    delete the explanation in order to pass is a test that makes the codebase
    worse.
    """
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    js = re.sub(r"(?m)^\s*//.*$", "", js)
    return js


compose_path = os.path.join(SRC, "feedback", "compose.js")
if os.path.exists(compose_path):
    compose_code = strip_comments(open(compose_path, encoding="utf-8").read())
    check("compose.js never queries the internal table",
          "eval_notes_internal" not in compose_code, compose_code[:300])
    check("compose.js does not import the staff-wide accessor",
          "evaluationForStaff" not in compose_code)
    # The positive half: it must actually go through the one permitted accessor.
    check("compose.js reads only via parentFacingFeedback",
          "parentFacingFeedback" in compose_code)
else:
    print("  ....  compose.js not written yet - canary re-checks it when it lands")

print("\n=== 4. one row per coach per player: revisiting EDITS ===")
st, _ = call("POST", f"{ADMIN}/api/eval/{RID}", {
    "rating_skill": 5, "strengths": "Revised on Tuesday.", "growth_area": "Left hand.",
    "internal_note": INTERNAL_CANARY + " revised",
})
out = _wrangler(f"SELECT COUNT(*) AS n FROM eval_feedback WHERE registration_id={RID}")
check("still one feedback row for this coach", '"n": 1' in out, out[-200:])
out = _wrangler(f"SELECT rating_skill, created_at != updated_at AS edited FROM eval_feedback WHERE registration_id={RID}")
check("the edit landed", '"rating_skill": 5' in out, out[-200:])
check("created_at is preserved so provenance survives", '"edited": 1' in out, out[-200:])

print("\n=== 5. clearing the internal box deletes the note ===")
call("POST", f"{ADMIN}/api/eval/{RID}", {"internal_note": "", "strengths": "Still here."})
out = _wrangler(f"SELECT COUNT(*) AS n FROM eval_notes_internal WHERE registration_id={RID}")
check("cleared internal note is removed, not left empty", '"n": 0' in out, out[-200:])

print("\n=== 6. attribution cannot be forged ===")
set_role("admin")
# The on_behalf_of path was removed on the owner's instruction. An evaluation
# has to be attributable to whoever typed it, or it is not evidence of anything;
# an admin transcribing under a coach's name destroys exactly that. Non-
# repudiation was chosen over the convenience of entering notes for someone.
st, r = call("POST", f"{ADMIN}/api/eval/{RID}", {
    "on_behalf_of": COACH, "author_email": COACH, "author": COACH,
    "strengths": "Attempted to write this under another coach's name.",
    "growth_area": "Should still be attributed to the caller.",
})
check("the request is accepted", st == 200 and r.get("ok"), str(r))
check("but attribution is the CALLER, never what the request claimed",
      r.get("saved_as") == "Coach Adams", str(r))

out = _wrangler(f"SELECT author_email FROM eval_feedback WHERE registration_id={RID}")
check("nothing is attributed to the coach named in the request", COACH not in out, out[-200:])
check("it is attributed to the signed-in admin", ME in out, out[-200:])

print("\n=== 6b. an admin may REMOVE another coach's evaluation, never rewrite it ===")
sql("INSERT INTO eval_feedback (player_id, registration_id, event_id, author_email, author_label, "
    "strengths, growth_area, created_at, updated_at) SELECT player_id, id, event_id, "
    f"'{COACH}', 'Coach Turner', 'Their own observation.', 'Their own growth note.', "
    f"datetime('now'), datetime('now') FROM registrations WHERE id={RID}")
out = _wrangler(f"SELECT author_email FROM eval_feedback WHERE registration_id={RID}")
check("the other coach has an entry of their own", COACH in out, out[-200:])

set_role("coach")
st, r = call("POST", f"{ADMIN}/api/eval/{RID}/author/delete", {"author_email": COACH})
check("a coach cannot remove another coach's evaluation", st == 403, f"got {st}")

set_role("admin")
st, r = call("POST", f"{ADMIN}/api/eval/{RID}/author/delete", {"author_email": COACH})
check("an admin can remove it", st == 200 and r.get("ok"), str(r)[:200])
out = _wrangler(f"SELECT author_email FROM eval_feedback WHERE registration_id={RID}")
check("it is gone", COACH not in out, out[-200:])

log = _wrangler("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 3")
check("the removal is audited, naming who removed whose",
      "eval.delete" in log and ME in log, log[-300:])

print("\n=== 7. a viewer cannot write at all ===")
set_role("viewer")
st, r = call("POST", f"{ADMIN}/api/eval/{RID}", {"strengths": "Viewer attempt."})
check("viewer is refused", st == 403, f"got {st}")
set_role("admin")

print("\n=== 8. unknown registration is refused ===")
st, r = call("POST", f"{ADMIN}/api/eval/999999", {"strengths": "x"})
check("unknown registration is 404", st == 404, f"got {st}")

print("\n=== 9. player identity is durable and not duplicated ===")
out = _wrangler("SELECT COUNT(*) AS n FROM players")
check("exactly one player row for one child", '"n": 1' in out, out[-200:])
out = _wrangler(f"SELECT player_id FROM registrations WHERE id={RID}")
check("the registration is linked to it", '"player_id": ' in out and '"player_id": null' not in out,
      out[-200:])

print("\n=== 10. completeness reporting drives the decision meeting ===")
register("Ava Blake", 2)
st, body = call("GET", ADMIN + "/eval")
check("players with no notes are visible as such", "no notes" in str(body))
check("progress is reported as a fraction", re.search(r"<strong>\d+ of \d+</strong>", str(body)) is not None)

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
