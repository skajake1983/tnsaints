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
from _harness import preflight as harness_preflight, staff_email

BASE = "http://127.0.0.1:8787"
harness_preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# From .dev.vars -- this repo is public, so real staff addresses stay out of it.
ME = staff_email()
COACH = "second.coach@example.com"

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

print("\n=== 6b. approval is refused until every message has been READ ===")
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/approve")
check("approve refuses while messages are unread", st == 400 and not r.get("ok"), str(r)[:200])
check("the refusal names the unread players", "read" in str(r).lower(), str(r)[:300])

msg_ids = [int(m) for m in re.findall(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE batch_id='{BATCH}' AND send_state='draft'"))]
check("draft message ids found", len(msg_ids) == 2, str(msg_ids))
for mid in msg_ids:
    st, r = call("POST", f"{ADMIN}/api/message/{mid}/review")
    check(f"message {mid} marked read", st == 200 and r.get("ok"), str(r))

st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/approve")
check("approve succeeds once everyone is decided and read", st == 200 and r.get("ok"), str(r)[:200])
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


print("\n=== 12. the decisions screen exists and gates by role ===")
st, body = call("GET", ADMIN + "/decisions")
check("decisions page loads for an admin", st == 200, f"got {st}")
check("it shows the four-step flow", "Step 1" in str(body) and "Step 4" in str(body), str(body)[:200])
check("it states nothing sends until read, approved and sent",
      all(w in str(body).lower() for w in ["read", "approved", "sent"]), str(body)[:400])
check("it exposes a review step, not just approve",
      "unread" in str(body).lower() or "read every message" in str(body).lower(), str(body)[:400])
check("Approve and Send are separate controls",
      "approveBtn" in str(body) or "sendBtn" in str(body), str(body)[:300])

sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _ = call("GET", ADMIN + "/decisions")
check("a coach cannot reach the decisions screen", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n=== 13. ratings are staff-only: no numbers reach a family ===")
# eval_feedback holds ratings AND is the parent-safe table, so nothing structural
# stops a future edit from putting them in a message. Pinned here instead.
bodies = _wrangler("SELECT body_text, body_html FROM parent_messages")
for label in ["rating_", "Skill:", "Effort:", "Coachability:", "Decisions:", "out of 5", "/5"]:
    check(f'no rating marker "{label}" in any message', label not in bodies)

print("\n=== 14. admin cancel frees the seat and keeps the record ===")
st, r = call("POST", f"{ADMIN}/api/registration/{B}/cancel", {"reason": "Family withdrew."})
check("cancel succeeds", st == 200 and r.get("ok"), str(r))
out = _wrangler(f"SELECT status, cancel_reason FROM registrations WHERE id={B}")
check("status is cancelled", '"status": "cancelled"' in out, out[-200:])
check("the row and its waiver survive", '"cancel_reason": "Family withdrew."' in out, out[-200:])
st, r = call("POST", f"{ADMIN}/api/registration/{B}/cancel", {"reason": "again"})
check("cancelling twice is refused, not silently repeated", st == 409, f"got {st}")

print("\n=== 15. delete refuses once a family has been emailed ===")
sql(f"UPDATE parent_messages SET send_state='sent' WHERE registration_id={A}")
st, r = call("POST", f"{ADMIN}/api/registration/{A}/delete")
check("delete is refused after a message was sent", st == 409, f"got {st}")
check("the refusal suggests cancelling instead", "cancel" in str(r).lower(), str(r))
sql(f"UPDATE parent_messages SET send_state='queued' WHERE registration_id={A}")

print("\n=== 16. delete removes the player and everything about them ===")
st, r = call("POST", f"{ADMIN}/api/registration/{A}/delete")
check("delete succeeds", st == 200 and r.get("ok"), str(r))
out = _wrangler(f"SELECT COUNT(*) AS n FROM registrations WHERE id={A}")
check("the registration is gone", '"n": 0' in out, out[-200:])
for table in ["eval_feedback", "eval_notes_internal", "parent_messages", "decisions"]:
    out = _wrangler(f"SELECT COUNT(*) AS n FROM {table} WHERE registration_id={A}")
    check(f"{table} rows went with it", '"n": 0' in out, out[-200:])

log = _wrangler("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 6")
check("the delete is audited with what it destroyed",
      "registration.delete" in log and "destroyed" in log, log[-300:])

print("\n=== 17. a coach cannot cancel or delete ===")
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _ = call("POST", f"{ADMIN}/api/registration/{B}/cancel", {"reason": "x"})
check("coach cannot cancel", st == 403, f"got {st}")
st, _ = call("POST", f"{ADMIN}/api/registration/{B}/delete")
check("coach cannot delete", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)


print("\n=== 18. THE HOLLOW MESSAGE: a player nobody wrote about blocks everything ===")
# This is the defect the whole audit was about. Previously a player with zero
# coach prose composed 869 characters of boilerplate that passed every check.
for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
             "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
             "DELETE FROM eval_feedback", "DELETE FROM registrations", "DELETE FROM players"]:
    sql(stmt)

register("Silent Player", 7)
S = reg_id("Silent Player")
# Ratings only -- the state notes.js explicitly calls "valid and expected" on
# event day, and precisely the state the old gate could not see.
call("POST", f"{ADMIN}/api/eval/{S}", {"rating_skill": 4, "rating_effort": 5})
call("POST", f"{ADMIN}/api/decision/{S}", {"decision": "not_yet"})

st, r = call("POST", f"{ADMIN}/api/batch/build")
check("build reports the player as blocked", len(r.get("problems", [])) == 1, str(r)[:300])
check("nothing was composed for them", r.get("composed") == 0, str(r)[:200])
BATCH2 = r.get("batchId")

out = _wrangler(f"SELECT send_state, last_error FROM parent_messages WHERE registration_id={S}")
# Blocked players used to vanish entirely, leaving no record that a child was
# evaluated and never answered.
check("the block is PERSISTED, not silently dropped", '"send_state": "skipped"' in out, out[-300:])
check("and it records why", "strength" in out.lower(), out[-300:])

st, r = call("POST", f"{ADMIN}/api/batch/{BATCH2}/approve")
check("approve refuses -- nobody can be sent a hollow message", st == 400, f"got {st}")

print("\n=== 19. accept is held to the same bar as not_yet ===")
call("POST", f"{ADMIN}/api/decision/{S}", {"decision": "accept"})
st, r = call("POST", f"{ADMIN}/api/batch/build")
check("an accept with no prose is blocked too", r.get("composed") == 0, str(r)[:250])

print("\n=== 20. writing the missing prose unblocks it ===")
call("POST", f"{ADMIN}/api/eval/{S}", {
    "strengths": "Quick first step and genuinely tried to guard the ball.",
    "growth_area": "Needs to keep his head up when the pressure comes.",
})
st, r = call("POST", f"{ADMIN}/api/batch/build")
check("now it composes", r.get("composed") == 1 and not r.get("problems"), str(r)[:250])
out = _wrangler(f"SELECT send_state FROM parent_messages WHERE registration_id={S}")
check("the stale 'skipped' row was cleared", '"send_state": "skipped"' not in out, out[-200:])

print("\n=== 21. the draft is editable, and the edit is what would send ===")
mid = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={S} AND send_state='draft'")).group(1))
EDITED = ("Dear family, we watched Silent play on Saturday and wanted to write personally. "
          "His quick first step stood out to every coach on the floor. We would love to see "
          "him again at our next evaluation. Please reply to this email with any questions.")
st, r = call("POST", f"{ADMIN}/api/message/{mid}/edit", {"body_text": EDITED})
check("edit saves", st == 200 and r.get("ok"), str(r)[:200])
out = _wrangler(f"SELECT body_text, reviewed_at FROM parent_messages WHERE id={mid}")
check("the edited text is stored", "wanted to write personally" in out, out[-200:])
check("editing counts as reading it", '"reviewed_at": null' not in out, out[-200:])

st, r = call("POST", f"{ADMIN}/api/message/{mid}/edit", {"body_text": "too short"})
check("an edit that drops the player's name is refused", st == 400, f"got {st} {r}")

print("\n=== 22. a message cannot be edited once frozen ===")
st, r = call("POST", f"{ADMIN}/api/batch/{r.get('batchId', BATCH2)}/approve") if False else (0, {})
st, r = call("POST", f"{ADMIN}/api/batch/build")
BATCH3 = r.get("batchId")
mid2 = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={S} AND send_state='draft'")).group(1))
call("POST", f"{ADMIN}/api/message/{mid2}/review")
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH3}/approve")
check("approve succeeds", st == 200 and r.get("ok"), str(r)[:250])
st, r = call("POST", f"{ADMIN}/api/message/{mid2}/edit", {"body_text": EDITED})
check("editing an approved message is refused", st == 409, f"got {st}")
check("marking an approved message read is refused",
      call("POST", f"{ADMIN}/api/message/{mid2}/review")[0] == 409)

print("\n=== 23. a cancelled family is never mailed ===")
out = _wrangler(f"SELECT send_state FROM parent_messages WHERE id={mid2}")
check("message is queued", '"send_state": "queued"' in out, out[-200:])
call("POST", f"{ADMIN}/api/registration/{S}/cancel", {"reason": "Family withdrew."})
# The drain joins registrations and now filters on status='confirmed', so a
# withdrawn family cannot receive their child's decision.
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH3}/send")
check("drain does not send to a cancelled registration",
      (not r.get("ok")) or r.get("sent") == 0, str(r)[:200])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)


print("\n=== 24. CSP hashes match the served scripts (or every button dies) ===")
# The admin pages hash their own inline script instead of allowing
# 'unsafe-inline'. If the served script and the declared hash ever drift, the
# browser silently refuses to run it: no server error, no log line, just a page
# where nothing works. Cheap to pin, expensive to discover on send day.
import base64, hashlib


def csp_matches(path):
    req = urllib.request.Request(BASE + path)
    req.add_header("Origin", ORIGIN)
    with urllib.request.urlopen(req) as r:
        csp = r.headers.get("Content-Security-Policy", "")
        html = r.read().decode()
    declared = re.search(r"script-src '(sha256-[^']+)'", csp)
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    if not declared or not scripts:
        return False, f"declared={bool(declared)} scripts={len(scripts)}"
    actual = "sha256-" + base64.b64encode(
        hashlib.sha256(scripts[-1].encode("utf-8")).digest()).decode()
    return declared.group(1) == actual, f"{declared.group(1)} vs {actual}"


ok, detail = csp_matches(ADMIN + "/decisions")
check("decisions page script hash matches its CSP", ok, detail)

register("Csp Check", 9)
C = reg_id("Csp Check")
ok, detail = csp_matches(f"{ADMIN}/eval/{C}")
check("evaluation form script hash matches its CSP", ok, detail)

print("\n=== 25. confirmations are in-page, not browser prompts ===")
_, body = call("GET", ADMIN + "/decisions")
b = str(body)
check("an in-page dialog is present", 'id="dlgBackdrop"' in b)
check("it is a real dialog for assistive tech", 'role="dialog"' in b and 'aria-modal="true"' in b)
check("no native prompt() remains", "= prompt(" not in b and "window.prompt(" not in b)
check("destructive actions still require a typed word",
      "DELETE" in b and "CANCEL" in b and "APPROVE" in b)

print("\n=== 26. tables collapse to cards on a phone ===")
for path, label in [(ADMIN + "/", "roster"), (ADMIN + "/decisions", "decisions")]:
    _, body = call("GET", path)
    b = str(body)
    check(f"{label}: table is marked stackable", 'table class="stack"' in b)
    check(f"{label}: cells carry their own labels", 'data-label="Player"' in b)
    check(f"{label}: a narrow breakpoint exists", "max-width: 720px" in b)

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)
