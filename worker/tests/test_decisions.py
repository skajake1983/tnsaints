"""Decisions, batching, the approve gate, and the send drain.

Nothing in this suite sends real email: EMAIL_DAILY_LIMIT is 0 locally and
there is no Resend key, so the drain exercises the state machine and stops at
the point of actually calling the provider. That is the interesting part
anyway -- the failure modes worth testing are double-sends, half-sent batches,
and messages going out that nobody approved.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight as harness_preflight

BASE = "http://127.0.0.1:8787"
harness_preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ME = "jacoblewisadams@gmail.com"
COACH = "turner@tnsaints.com"

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


def register(name, n):
    return call("POST", "/api/register", {
        "session_time": "9:00 AM", "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": f"Parent {name}",
        "parent_email": f"dec{n}@example.com", "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Registration created for decision-batch tests.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "d",
    })


def reg_id(name):
    out = _wrangler(f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


print("\n=== setup: two players, notes written for both ===")
for stmt in ["DELETE FROM parent_feedback", "DELETE FROM parent_messages",
             "DELETE FROM decisions", "DELETE FROM decision_batches",
             "DELETE FROM eval_notes_internal", "DELETE FROM eval_feedback",
             "DELETE FROM registrations", "DELETE FROM players",
             "DELETE FROM audit_log", "DELETE FROM email_budget", "DELETE FROM staff"]:
    sql(stmt)

sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{COACH}', 'Brandon Turner', 'Coach Turner', 'coach', 1, datetime('now'), datetime('now'))")

register("Marcus Reed", 1)
register("Ava Blake", 2)
A, B = reg_id("Marcus Reed"), reg_id("Ava Blake")
check("two registrations created", A and B and A != B)

for rid in (A, B):
    call("POST", f"{ADMIN}/api/eval/{rid}", {
        "rating_skill": 4, "rating_effort": 5, "rating_coachability": 4, "rating_decisions": 3,
        "strengths": "Kept his head up in transition and found the trailer twice, which is rare at this age.",
        "growth_area": "Left hand under pressure - everything goes right at the moment.",
        "internal_note": "INTERNAL-CANARY-NEVER-SEND parent was difficult on the sideline.",
    })

print("\n=== 1. a batch cannot be built while anyone is undecided ===")
st, r = call("POST", f"{ADMIN}/api/batch/build")
check("build succeeds but reports blockers", st == 200 and r.get("ok"), str(r)[:200])
check("undecided players are listed as problems", len(r.get("problems", [])) == 2, str(r)[:300])
check("nothing was composed for them", r.get("composed") == 0, str(r)[:200])

BATCH = r.get("batchId")
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/approve")
check("approving refuses while undecided", st == 400 and not r.get("ok"), str(r)[:200])
check("the refusal says why", "decision" in str(r).lower(), str(r)[:200])

print("\n=== 2. decisions, then a real batch ===")
st, r = call("POST", f"{ADMIN}/api/decision/{A}", {"decision": "accept"})
check("accept recorded", st == 200 and r.get("ok"), str(r))
st, r = call("POST", f"{ADMIN}/api/decision/{B}", {"decision": "not_yet"})
check("not_yet recorded", st == 200 and r.get("ok"), str(r))

st, r = call("POST", f"{ADMIN}/api/batch/build")
check("batch builds cleanly now", st == 200 and r.get("ok") and not r.get("problems"), str(r)[:300])
check("one message per player", r.get("composed") == 2, str(r)[:200])
BATCH = r.get("batchId")

print("\n=== 3. THE CANARY: no internal note reached a composed message ===")
msgs = _wrangler("SELECT subject, body_text, body_html FROM parent_messages")
check("composed messages contain NO internal note", "INTERNAL-CANARY-NEVER-SEND" not in msgs)
check("but they do contain the parent-facing strength",
      "found the trailer" in msgs, msgs[-300:])

print("\n=== 4. accept and not_yet share a subject line ===")
out = _wrangler("SELECT subject FROM parent_messages ORDER BY id")
subjects = re.findall(r'"subject":\s*"([^"]+)"', out)
check("two subjects captured", len(subjects) == 2, str(subjects))
if len(subjects) == 2:
    # Families compare subject lines in the parking lot. A subject that reveals
    # the verdict turns fifty private messages into a public tier list.
    a_sub = subjects[0].split(" from ")[0]
    b_sub = subjects[1].split(" from ")[0]
    check("neither subject reveals the outcome",
          not any(w in " ".join(subjects).lower()
                  for w in ["not selected", "rejected", "unsuccessful", "congratulations", "accepted"]),
          str(subjects))
    check("subjects differ only by the player's name", a_sub != b_sub, str(subjects))

print("\n=== 5. the 'not yet' message never uses rejecting language ===")
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={B}")
low = out.lower()
for word in ["not selected", "rejected", "unsuccessful", "did not make"]:
    check(f'"not yet" avoids the phrase "{word}"', word not in low)
check('"not yet" names something specific the player did', "trailer" in low, out[-300:])
check('"not yet" offers a concrete next step', "evaluation" in low or "back at the next" in low, out[-300:])

print("\n=== 6. preflight reports the budget BEFORE the button ===")
st, r = call("GET", f"{ADMIN}/api/batch/{BATCH}/preflight")
check("preflight responds", st == 200 and r.get("ok"), str(r))
check("it reports how many would send", r.get("to_send") == 0, f"pre-approval, so 0: {r}")

st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/approve")
check("approve succeeds once everyone is decided", st == 200 and r.get("ok"), str(r)[:200])
check("both messages queued", r.get("queued") == 2, str(r))

st, r = call("GET", f"{ADMIN}/api/batch/{BATCH}/preflight")
check("preflight now counts the queued messages", r.get("to_send") == 2, str(r))
# EMAIL_DAILY_LIMIT is 0 locally, so this must report a shortfall rather than
# cheerfully proceeding -- the whole point is to find this out before sending.
check("it reports the budget shortfall", r.get("enough") is False and r.get("shortfall") == 2, str(r))

def body_text_of(registration_id):
    """Extract just the stored body.

    Comparing raw wrangler output was wrong: it wraps results in JSON carrying a
    per-query "duration", so two identical bodies compared unequal whenever
    timing differed. That check passed in isolation and failed in a full run --
    the worst shape of flake, because the version that passes looks correct.
    """
    out = _wrangler(
        f"SELECT body_text FROM parent_messages WHERE registration_id={registration_id}"
    )
    m = re.search(r'"body_text":\s*"((?:[^"\\]|\\.)*)"', out)
    return m.group(1) if m else None


print("\n=== 7. approval snapshots the message ===")
before = body_text_of(A)
check("a queued body was found to compare", before is not None)
# Change the underlying note AFTER approval. The queued message must not move:
# what was reviewed is what sends.
call("POST", f"{ADMIN}/api/eval/{A}", {
    "strengths": "COMPLETELY DIFFERENT TEXT WRITTEN AFTER APPROVAL",
    "growth_area": "Also changed.",
})
after = body_text_of(A)
check("the queued message is unchanged by a later note edit", before == after,
      f"before[{len(before or '')}] != after[{len(after or '')}]")
check("the new text did NOT leak into the queued message",
      "COMPLETELY DIFFERENT TEXT" not in (after or ""))

print("\n=== 8. one batch in flight at a time ===")
st, r = call("POST", f"{ADMIN}/api/batch/build")
check("a second batch is refused while one is approved", st == 400 and not r.get("ok"), str(r)[:200])

print("\n=== 9. the drain stops on budget rather than failing messages ===")
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/send")
# Locally there is no Resend key, so the drain refuses before claiming anything.
check("drain refuses cleanly with no email configured", st == 400 and not r.get("ok"), str(r)[:200])
state = _wrangler(f"SELECT send_state, send_attempts FROM parent_messages WHERE batch_id='{BATCH}'")
check("no message was left mid-send", '"send_state": "sending"' not in state, state[-300:])
check("no send attempts were burned", '"send_attempts": 0' in state, state[-300:])

print("\n=== 10. roles: a coach cannot decide or send ===")
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _ = call("POST", f"{ADMIN}/api/decision/{A}", {"decision": "accept"})
check("coach cannot set a decision", st == 403, f"got {st}")
st, _ = call("POST", f"{ADMIN}/api/batch/build")
check("coach cannot build a batch", st == 403, f"got {st}")
st, _ = call("POST", f"{ADMIN}/api/batch/{BATCH}/send")
check("coach cannot send", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n=== 11. every decision and batch action is audited ===")
log = _wrangler("SELECT actor, action, subject_id FROM audit_log ORDER BY id DESC LIMIT 30")
for action in ["decision.set", "batch.build", "batch.approve"]:
    check(f"{action} is audited", action in log, log[-200:])
check("the audit log holds no message bodies", "trailer" not in log)

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
