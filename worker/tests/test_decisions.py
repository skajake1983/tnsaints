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
# Budget is ample locally now that sending goes to a loopback sink; what
# matters is that preflight reports the real numbers before the button.
check("preflight reports enough budget and the true count",
      r.get("to_send") == 2 and r.get("enough") is True, str(r))

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

print("\n=== 9. draining never strands a message mid-send ===")
# Delivery itself -- and critically WHICH ADDRESS RECEIVES WHICH BODY -- is
# covered by tests/test_send_path.py, which runs a loopback mail sink. No sink
# is listening during this suite, so every send fails at the transport; what is
# asserted here is only that the state machine cannot strand anything.
#
# This previously asserted the drain refused because email was unconfigured.
# That was true and useless: it meant the entire send path below that guard had
# never executed in any test.
st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/send")
check("the drain answers rather than hanging", st == 200, f"got {st} {str(r)[:160]}")
state = _wrangler(f"SELECT send_state FROM parent_messages WHERE batch_id='{BATCH}'")
check("nothing is left in 'sending'", '"send_state": "sending"' not in state, state[-300:])
check("a transport failure is recorded, not silently dropped",
      '"send_state": "failed"' in state or '"send_state": "queued"' in state, state[-300:])

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


def script_parses(path):
    """Is the script the page actually serves valid JavaScript?

    The CSP check above compares hashes and passes happily on a script with a
    syntax error -- the hash of broken text matches the hash of broken text. A
    single unescaped apostrophe in a JS string killed the entire eval page
    script this way: every handler failed to attach, so the form fell back to a
    NATIVE submit, the browser navigated to /api/eval/2, and the Worker replied
    "Could not read that submission" because it received form encoding instead
    of JSON. Nothing anywhere reported a script error.
    """
    req = urllib.request.Request(BASE + path)
    req.add_header("Origin", ORIGIN)
    with urllib.request.urlopen(req) as r:
        html = r.read().decode()
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    if not scripts:
        return False, "no inline script"
    tmp = os.path.join(WORKER_DIR, ".script-check.js")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(scripts[-1])
    try:
        res = subprocess.run(["node", "--check", tmp], capture_output=True,
                             shell=(os.name == "nt"), cwd=WORKER_DIR)
        detail = (res.stderr or b"").decode("utf-8", errors="replace")
        return res.returncode == 0, detail[:300]
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


ok, detail = script_parses(ADMIN + "/decisions")
check("decisions page script is valid JavaScript", ok, detail)
ok, detail = script_parses(f"{ADMIN}/eval/{C}")
check("evaluation form script is valid JavaScript", ok, detail)

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


print("\n=== 27. destructive labels name what they act on ===")
_, body = call("GET", ADMIN + "/decisions")
b = str(body)
# "Cancel" alone reads as "dismiss this action" in every other UI on earth, and
# it sat directly beside Delete. Ambiguity next to an irreversible button is
# how the wrong child gets removed.
check("the row button says what it cancels", "Cancel spot" in b, b[:200])
check("assistive tech gets the player's name too", "aria-label=\"Cancel " in b)
check("delete is likewise labelled with the player", 'aria-label="Permanently delete' in b)
# Two buttons both beginning "Cancel", one inert and one releasing a spot.
check("the dialog dismiss is not also called Cancel", ">Go back<" in b)
check("no bare Cancel button remains", ">Cancel</button>" not in b, b[:300])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)


print("\n=== 28. CHANGING A DECISION INVALIDATES THE DRAFT ===")
# The owner found this: flip not_yet -> accept after building, and the stored
# draft still said "We are not able to offer a spot". Approving and sending
# would tell an ACCEPTED family they were turned away.
for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
             "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
             "DELETE FROM eval_feedback", "DELETE FROM registrations", "DELETE FROM players"]:
    sql(stmt)

register("Flip Player", 11)
F = reg_id("Flip Player")
call("POST", f"{ADMIN}/api/eval/{F}", {
    "strengths": "Reads the floor unusually well for his age and moves the ball early.",
    "growth_area": "Wants to go left more often under pressure.",
})
call("POST", f"{ADMIN}/api/decision/{F}", {"decision": "not_yet"})
st, r = call("POST", f"{ADMIN}/api/batch/build")
BF = r.get("batchId")
check("draft built for not_yet", r.get("composed") == 1, str(r)[:200])

out = _wrangler(f"SELECT body_text, composed_for_decision FROM parent_messages WHERE registration_id={F}")
check("the draft says what a not_yet says", "not able to offer" in out.lower(), out[-250:])
check("and records which decision it was written for",
      '"composed_for_decision": "not_yet"' in out, out[-250:])

mid = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={F}")).group(1))
call("POST", f"{ADMIN}/api/message/{mid}/review")

# Now flip it.
st, r = call("POST", f"{ADMIN}/api/decision/{F}", {"decision": "accept"})
check("the flip is reported as invalidating the draft", r.get("staleDraft") is True, str(r))

out = _wrangler(f"SELECT reviewed_at FROM parent_messages WHERE id={mid}")
check("the earlier read no longer counts", '"reviewed_at": null' in out, out[-200:])

st, r = call("POST", f"{ADMIN}/api/batch/{BF}/approve")
check("APPROVE IS REFUSED while the text contradicts the decision", st == 400, f"got {st}")
check("and it says the decision changed", "decision" in str(r).lower(), str(r)[:300])

st, r = call("POST", f"{ADMIN}/api/batch/{BF}/send")
check("send is refused too", st == 400 or r.get("sent") == 0, str(r)[:200])

print("\n=== 29. rebuilding regenerates it for the new decision ===")
st, r = call("POST", f"{ADMIN}/api/batch/build")
out = _wrangler(f"SELECT body_text, composed_for_decision FROM parent_messages WHERE registration_id={F}")
check("the draft now matches the new decision",
      '"composed_for_decision": "accept"' in out, out[-250:])
check("and no longer reads as a rejection", "not able to offer" not in out.lower(), out[-250:])
check("it must be read again", '"reviewed_at": null' in _wrangler(
      f"SELECT reviewed_at FROM parent_messages WHERE registration_id={F}"))

print("\n=== 30. rebuilding does NOT destroy hand-edited messages ===")
mid2 = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={F} AND send_state='draft'")).group(1))
MINE = ("Flip played really well on Saturday and we would love to have him. He reads the floor "
        "unusually well for his age. Please reply to this email and we will get him started.")
call("POST", f"{ADMIN}/api/message/{mid2}/edit", {"body_text": MINE})
st, r = call("POST", f"{ADMIN}/api/batch/build")
# Rebuilding used to delete every draft, so an admin who had rewritten forty
# messages lost all forty by changing one player's decision.
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={F}")
check("a hand-edited draft survives a rebuild", "would love to have him" in out, out[-250:])
check("and the rebuild reports it as kept", r.get("keptEdited") == 1, str(r)[:200])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)


print("\n=== 31. NOTES changing after build invalidates the draft ===")
# The dangerous case: a coach types one child's observations into another
# child's form (the exact mistake on-behalf-of exists to repair), a batch is
# built overnight, and the notes are corrected the next day. Without this the
# corrected player keeps a snapshot containing somebody else's child.
for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
             "DELETE FROM decision_batches", "DELETE FROM eval_feedback",
             "DELETE FROM eval_notes_internal", "DELETE FROM registrations",
             "DELETE FROM players"]:
    sql(stmt)

register("Notes Player", 12)
N = reg_id("Notes Player")
call("POST", f"{ADMIN}/api/eval/{N}", {
    "strengths": "Originally written about a different child entirely.",
    "growth_area": "Also the wrong child.",
})
call("POST", f"{ADMIN}/api/decision/{N}", {"decision": "accept"})
st, r = call("POST", f"{ADMIN}/api/batch/build")
BN = r.get("batchId")
mid = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={N}")).group(1))
call("POST", f"{ADMIN}/api/message/{mid}/review")
st, _ = call("POST", f"{ADMIN}/api/batch/{BN}/approve")
check("a correct, read draft approves normally", st == 200, f"got {st}")

# Reopen by rebuilding a fresh cycle, then correct the notes mid-flight.
sql("DELETE FROM parent_messages")
sql(f"UPDATE decision_batches SET state='draft' WHERE id='{BN}'")
call("POST", f"{ADMIN}/api/batch/build")
mid = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={N}")).group(1))
call("POST", f"{ADMIN}/api/message/{mid}/review")
out = _wrangler(f"SELECT reviewed_at FROM parent_messages WHERE id={mid}")
check("it is read", '"reviewed_at": null' not in out, out[-160:])

call("POST", f"{ADMIN}/api/eval/{N}", {
    "strengths": "Corrected: this is what THIS player actually did on Saturday.",
    "growth_area": "Corrected growth area for this player.",
})
out = _wrangler(f"SELECT reviewed_at FROM parent_messages WHERE id={mid}")
check("correcting the notes un-reads the draft", '"reviewed_at": null' in out, out[-160:])

st, r = call("POST", f"{ADMIN}/api/batch/{BN}/approve")
check("approve is refused after the notes changed", st == 400, f"got {st} {str(r)[:200]}")

st, r = call("POST", f"{ADMIN}/api/batch/build")
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={N}")
check("rebuilding picks up the corrected notes", "what THIS player actually did" in out, out[-250:])
check("and drops the wrong child's text", "different child entirely" not in out, out[-250:])

print("\n=== 32. a decision cannot change once committed to a family ===")
mid = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={N} AND send_state='draft'")).group(1))
call("POST", f"{ADMIN}/api/message/{mid}/review")
st, r = call("POST", f"{ADMIN}/api/batch/{BN}/approve")
check("approve succeeds", st == 200 and r.get("ok"), str(r)[:220])

# A stale tab still has live decision buttons; markup-disabled is not a control.
st, r = call("POST", f"{ADMIN}/api/decision/{N}", {"decision": "not_yet"})
check("flipping a decision after approval is REFUSED", st == 400, f"got {st}")
check("and it explains the message is already committed",
      "approved" in str(r).lower() or "already" in str(r).lower(), str(r)[:220])

out = _wrangler(f"SELECT decision FROM decisions WHERE registration_id={N}")
check("the decision on record is unchanged", '"decision": "accept"' in out, out[-160:])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)

print("\n=== 33. the edit box cannot carry a staff-only note to a family ===")
# Adding an edit box closed one hole and opened two. The composer could only
# assemble parent-facing fields; a person typing free text is looking at a
# screen that also shows every coach's staff-only notes, and the blocked-player
# links lead straight to the page that displays them.
for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
             "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
             "DELETE FROM eval_feedback", "DELETE FROM registrations",
             "DELETE FROM players"]:
    sql(stmt)

register("Guard One", 21)
register("Guard Two", 22)
G1, G2 = reg_id("Guard One"), reg_id("Guard Two")
SECRET = "the father was extremely difficult on the sideline all morning long"
call("POST", f"{ADMIN}/api/eval/{G1}", {
    "strengths": "Competed hard on every single possession of the morning.",
    "growth_area": "Should look to use his left hand far more often.",
    "internal_note": SECRET,
})
call("POST", f"{ADMIN}/api/eval/{G2}", {
    "strengths": "Finished through contact with either hand repeatedly.",
    "growth_area": "Needs to communicate on defence much more.",
})
call("POST", f"{ADMIN}/api/decision/{G1}", {"decision": "accept"})
call("POST", f"{ADMIN}/api/decision/{G2}", {"decision": "not_yet"})
call("POST", f"{ADMIN}/api/batch/build")
m1 = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={G1}")).group(1))
m2 = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={G2}")).group(1))

st, r = call("POST", f"{ADMIN}/api/message/{m1}/edit", {
    "body_text": f"Dear family, Guard did well on Saturday. {SECRET} We would love to have him. "
                 "Please reply to this email with any questions at all."})
check("pasting a staff-only note into the message is REFUSED", st == 400, f"got {st}")
check("and the refusal says it is a staff-only note", "staff-only" in str(r).lower(), str(r)[:200])
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE id={m1}")
check("nothing was stored", "difficult on the sideline" not in out, out[-200:])

print("\n=== 34. the edit box cannot carry another child's message ===")
# Fifty drafts render as fifty textareas on one page, so copy-paste between them
# is the obvious way to reuse a paragraph that reads well.
st, r = call("POST", f"{ADMIN}/api/message/{m1}/edit", {
    "body_text": "Dear family, thank you for bringing Guard Two out on Saturday. We watched them "
                 "closely and enjoyed having them in the gym. Please reply with any questions."})
check("naming another player in the message is REFUSED", st == 400, f"got {st} {str(r)[:160]}")
check("and the refusal names them", "Guard Two" in str(r), str(r)[:200])

print("\n=== 35. a legitimate edit still saves ===")
st, r = call("POST", f"{ADMIN}/api/message/{m1}/edit", {
    "body_text": "Dear family, Guard competed hard on every possession on Saturday and we would "
                 "love to have him join the academy. Please reply to this email with any questions."})
check("an ordinary rewrite is accepted", st == 200 and r.get("ok"), str(r)[:200])
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE id={m1}")
check("and it is stored", "competed hard on every possession" in out.lower(), out[-200:])


print("\n=== 36. bulk replace: fix the same wrong text in every message ===")
# buildBatch deliberately preserves hand-edited drafts, so a global correction
# like a wrong footer cannot be applied by rebuilding. Editing forty footers by
# hand at 11pm is the failure this exists to prevent.
for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
             "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
             "DELETE FROM eval_feedback", "DELETE FROM registrations",
             "DELETE FROM players"]:
    sql(stmt)

for i, nm in enumerate(["Bulk One", "Bulk Two", "Bulk Three"]):
    register(nm, 30 + i)
    rid = reg_id(nm)
    call("POST", f"{ADMIN}/api/eval/{rid}", {
        "strengths": f"{nm} competed hard on every possession all morning.",
        "growth_area": f"{nm} should use the left hand far more often.",
    })
    call("POST", f"{ADMIN}/api/decision/{rid}", {"decision": "accept"})
st, r = call("POST", f"{ADMIN}/api/batch/build")
BULK = r.get("batchId")
check("three drafts composed", r.get("composed") == 3, str(r)[:200])

# Hand-edit one, to prove a rebuild could not fix it but this can.
one = reg_id("Bulk One")
m_one = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={one}")).group(1))
call("POST", f"{ADMIN}/api/message/{m_one}/edit", {
    "body_text": "Dear family, Bulk played really well and we would love to have them. "
                 "Please reply with any questions.\\n\\n- Coach Adams\\n"
                 "Tennessee Saints Basketball Academy - info@tnsaints.com"})

st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace", {"find": "short", "replace": "x"})
check("a dangerously short find string is refused", st == 400, f"got {st} {str(r)[:160]}")
check("and it says why", "8 characters" in str(r), str(r)[:200])

st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "Tennessee Saints Basketball Academy", "replace": "TN Saints Academy",
              "preview": True})
check("preview reports how many match", st == 200 and r.get("matched") == 3, str(r)[:250])
check("preview does not change anything",
      "Tennessee Saints Basketball Academy" in _wrangler("SELECT body_text FROM parent_messages"))
check("preview shows a before and after for each match",
      bool(r.get("samples")) and r["samples"][0]["before"] != r["samples"][0]["after"],
      str(r)[:250])

st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "Tennessee Saints Basketball Academy", "replace": "TN Saints Academy"})
check("applying changes every match", st == 200 and r.get("changed") == 3, str(r)[:200])
out = _wrangler("SELECT body_text FROM parent_messages")
check("the old text is gone everywhere", "Tennessee Saints Basketball Academy" not in out)
check("the new text is there", "TN Saints Academy" in out)
check("the HAND-EDITED message was fixed too, which a rebuild could not do",
      out.count("TN Saints Academy") == 3, out[-200:])

out = _wrangler(f"SELECT reviewed_at FROM parent_messages WHERE batch_id='{BULK}'")
check("everything must be read again", out.count('"reviewed_at": null') == 3, out[-250:])

print("\n=== 37. a replacement that would break a message changes nothing ===")
st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "competed hard on every possession", "replace": "x"})
# Not fatal by itself; what must hold is that a refusal leaves nothing changed.
# Compare the extracted body values, not raw wrangler output — the latter
# carries a per-query "duration" that varies between two calls and would flake.
def _bodies():
    out = _wrangler("SELECT body_text FROM parent_messages ORDER BY id")
    return re.findall(r'"body_text":\s*"((?:[^"\\]|\\.)*)"', out)

before = _bodies()
st2, r2 = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
               {"find": "Dear family, Bulk played really well", "replace": "Hello there"})
after = _bodies()
check("removing the player name from a message is refused", st2 == 400, f"got {st2} {str(r2)[:200]}")
check("and nothing was written", before == after)

print("\n=== 38. only admins can bulk edit ===")
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "TN Saints Academy", "replace": "Something Else"})
check("a coach cannot bulk edit", st == 403, f"got {st}")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

log = _wrangler("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 8")
check("the bulk edit is audited", "messages.bulk_replace" in log, log[-300:])
check("but the audit holds no message content",
      "TN Saints Academy" not in log and "competed hard" not in log, log[-300:])


print("\n=== 39. bulk replace: the audit fixes ===")
# A replacement string is checked against EVERY internal note in the event, not
# just each recipient's own. Otherwise a paragraph lifted from one child's note
# passes for all the others, because it is not their note.
secret2 = "mum told me at the door that things have been very hard at home lately"
sql("DELETE FROM eval_notes_internal")
one = reg_id("Bulk One")
call("POST", f"{ADMIN}/api/eval/{one}", {"internal_note": secret2})

st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "TN Saints Academy",
              "replace": "TN Saints Academy. " + secret2, "preview": True})
check("a replacement carrying ANY child's staff-only note is refused",
      st == 400, f"got {st} {str(r)[:200]}")
check("and it says it is a staff-only note", "staff-only" in str(r).lower(), str(r)[:200])

print("\n=== 40. messages the replace could not match are NAMED ===")
# Someone who reflowed a sign-off has a body the needle no longer matches. A
# bare count would let their family keep the wrong footer with nobody the wiser.
two = reg_id("Bulk Two")
m_two = int(re.search(r'"id":\s*(\d+)', _wrangler(
    f"SELECT id FROM parent_messages WHERE registration_id={two}")).group(1))
call("POST", f"{ADMIN}/api/message/{m_two}/edit", {
    "body_text": "Dear family, Bulk competed hard on Saturday and we would love to have them "
                 "join us. Please reply to this email with any questions at all."})
st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "TN Saints Academy", "replace": "Tennessee Saints", "preview": True})
check("preview names the messages it cannot change", len(r.get("missed", [])) >= 1, str(r)[:300])
check("and shows a window around the actual match, not the start of the body",
      r.get("samples") and "Saints" in r["samples"][0]["before"], str(r)[:300])
check("before and after genuinely differ",
      r["samples"][0]["before"] != r["samples"][0]["after"], str(r.get("samples"))[:300])

print("\n=== 41. a rebuild after a bulk edit is not a deadlock ===")
# bulkReplace stamps edited_at on every message it touches. buildBatch preserves
# edited drafts -- so without also requiring the notes fingerprint to match, one
# later coach note would leave a message that cannot be edited (UI disables it),
# cannot be rebuilt (preserved), and blocks approval for the WHOLE batch.
st, r = call("POST", f"{ADMIN}/api/batch/{BULK}/replace",
             {"find": "TN Saints Academy", "replace": "Tennessee Saints Academy"})
check("the bulk edit applies", st == 200 and r.get("ok"), str(r)[:200])

three = reg_id("Bulk Three")
call("POST", f"{ADMIN}/api/eval/{three}", {
    "strengths": "A later correction from a coach, after the bulk edit.",
    "growth_area": "Also corrected afterwards."})
st, r = call("POST", f"{ADMIN}/api/batch/build")
check("rebuilding regenerates the note-stale message rather than preserving it",
      st == 200 and r.get("ok"), str(r)[:250])
out = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={three}")
check("it picked up the corrected note", "later correction from a coach" in out, out[-250:])

print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    for f in failed:
        print("  - " + f)
print("=" * 62)
