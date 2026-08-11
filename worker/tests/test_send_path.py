"""The send path: which address actually receives which body.

WHY THIS SUITE EXISTS

Everything below `if (!emailConfigured(env))` in drainBatch had never executed
under test. `.dev.vars` omitted the API key, so every run returned at that line
and the following were dead code in the suite:

  - retirement of messages queued for a family who withdrew
  - the r.status = 'confirmed' filter on the drain query
  - the guarded claim UPDATE that stops two drains double-sending
  - THE LAST GATE, re-checking decision and notes at the point of no return
  - the budget stop that must return a message to 'queued', not 'failed'
  - `to: message.parent_email` -- the line pairing a recipient with a body

That last one is the owner's single biggest fear, and nothing exercised it.
Someone could have changed the JOIN from registration_id to player_id -- which
is plausible, since the schema urges that PLAYER is the durable identity a
message anchors to -- and every test in the repo would still have passed while a
family was mailed another child's evaluation.

HOW IT IS SAFE

RESEND_ENDPOINT in .dev.vars points at a loopback sink this file starts. No
byte leaves the machine, whatever key is configured. The Worker runs its real
send path end to end and the sink records exactly what it was asked to deliver.
"""
import json
import os
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email

BASE = "http://127.0.0.1:8787"
preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ME = staff_email()
SINK_PORT = 8799

passed, failed = [], []
captured = []

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


class Sink(BaseHTTPRequestHandler):
    """Stands in for Resend. Records the payload, answers like the real API.

    Threaded, and answers with Connection: close. A plain single-threaded
    HTTPServer served the first message and then blocked -- the Worker's fetch
    keeps the connection open, so the second send never arrived and the batch
    came out half-delivered. That is precisely the shape of failure this suite
    exists to detect, so the harness must not be the thing producing it.
    """

    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            captured.append(json.loads(raw))
        except json.JSONDecodeError:
            captured.append({"unparseable": raw[:400]})
        body = json.dumps({"id": f"sink-{len(captured)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the suite output readable


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


def register(name, email, ip):
    return call("POST", "/api/register", {
        "session_time": "9:00 AM", "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": f"Parent of {name}",
        "parent_email": email, "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Registration created for send-path tests.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "d",
    })


def reg_id(name):
    out = _wrangler(f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


def msg_id(rid):
    out = _wrangler(f"SELECT id FROM parent_messages WHERE registration_id={rid} AND send_state='draft'")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


server = ThreadingHTTPServer(("127.0.0.1", SINK_PORT), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"\n  local mail sink listening on 127.0.0.1:{SINK_PORT} — nothing leaves this machine")

try:
    print("\n=== setup: two players with distinct notes and addresses ===")
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
                 "DELETE FROM eval_feedback", "DELETE FROM registrations",
                 "DELETE FROM players", "DELETE FROM email_budget", "DELETE FROM staff"]:
        sql(stmt)
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    register("Alpha Player", "alpha-parent@example.com", "10.61.0.1")
    register("Bravo Player", "bravo-parent@example.com", "10.62.0.1")
    A, B = reg_id("Alpha Player"), reg_id("Bravo Player")
    check("two registrations created", A and B and A != B)

    # Deliberately distinctive prose, so a swap is unmistakable.
    call("POST", f"{ADMIN}/api/eval/{A}", {
        "strengths": "ALPHAMARKER kept his head up in transition every single time.",
        "growth_area": "ALPHAGROWTH wants to go left more often under pressure.",
        "internal_note": "ALPHAINTERNAL the father was difficult on the sideline all morning.",
    })
    call("POST", f"{ADMIN}/api/eval/{B}", {
        "strengths": "BRAVOMARKER finished through contact with either hand repeatedly.",
        "growth_area": "BRAVOGROWTH needs to talk on defence far more.",
        "internal_note": "BRAVOINTERNAL we suspect he is playing up an age group.",
    })
    call("POST", f"{ADMIN}/api/decision/{A}", {"decision": "accept"})
    call("POST", f"{ADMIN}/api/decision/{B}", {"decision": "not_yet"})

    st, r = call("POST", f"{ADMIN}/api/batch/build")
    BATCH = r.get("batchId")
    check("both drafts composed", r.get("composed") == 2, str(r)[:200])

    for rid in (A, B):
        call("POST", f"{ADMIN}/api/message/{msg_id(rid)}/review")
    st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/approve")
    check("batch approved", st == 200 and r.get("ok"), str(r)[:220])

    print("\n=== 1. THE SEND ACTUALLY RUNS (this path was never executed before) ===")
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/send")
    check("drain reports success", st == 200 and r.get("ok"), str(r)[:220])
    check("it sent both", r.get("sent") == 2, str(r)[:220])
    check("the sink actually received two messages", len(captured) == 2, str(len(captured)))

    print("\n=== 2. EACH FAMILY RECEIVED THEIR OWN CHILD'S MESSAGE ===")
    by_to = {}
    for payload in captured:
        to = payload.get("to")
        by_to[(to[0] if isinstance(to, list) else to)] = payload

    check("Alpha's parent was written to", "alpha-parent@example.com" in by_to, str(list(by_to)))
    check("Bravo's parent was written to", "bravo-parent@example.com" in by_to, str(list(by_to)))

    alpha = by_to.get("alpha-parent@example.com", {})
    bravo = by_to.get("bravo-parent@example.com", {})
    alpha_blob = json.dumps(alpha)
    bravo_blob = json.dumps(bravo)

    # The pairing that matters. A JOIN changed from registration_id to
    # player_id, or a reordered result set, shows up here and nowhere else.
    check("Alpha's family got Alpha's observation", "ALPHAMARKER" in alpha_blob, alpha_blob[:200])
    check("Alpha's family got NOTHING about Bravo", "BRAVOMARKER" not in alpha_blob)
    check("Bravo's family got Bravo's observation", "BRAVOMARKER" in bravo_blob, bravo_blob[:200])
    check("Bravo's family got NOTHING about Alpha", "ALPHAMARKER" not in bravo_blob)
    check("Alpha's message names Alpha", "Alpha" in alpha_blob)
    check("neither message names the other child",
          "Bravo" not in alpha_blob and "Alpha" not in bravo_blob)

    print("\n=== 3. NO STAFF-ONLY NOTE LEFT THE BUILDING ===")
    everything = json.dumps(captured)
    for token in ("ALPHAINTERNAL", "BRAVOINTERNAL", "difficult on the sideline", "playing up an age group"):
        check(f"internal text absent from what was sent: {token}", token not in everything)

    print("\n=== 4. the accepted family was not told they were turned away ===")
    check("Alpha (accept) is not told there is no spot", "not able to offer" not in alpha_blob.lower())
    check("Bravo (not_yet) is told, kindly", "not able to offer" in bravo_blob.lower(), bravo_blob[:300])
    check("neither message uses rejecting language",
          not any(w in everything.lower() for w in ["rejected", "unsuccessful", "not selected"]))

    print("\n=== 5. state after a real send ===")
    out = _wrangler(f"SELECT send_state, provider_message_id FROM parent_messages WHERE batch_id='{BATCH}'")
    check("both messages are marked sent", out.count('"send_state": "sent"') == 2, out[-300:])
    check("the provider id is recorded", "sink-" in out, out[-300:])
    out = _wrangler(f"SELECT state FROM decision_batches WHERE id='{BATCH}'")
    check("the batch closed as sent", '"state": "sent"' in out, out[-200:])

    print("\n=== 6. sending again does NOT mail anyone twice ===")
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{BATCH}/send")
    check("a second drain sends nothing", len(captured) == 0, f"sink got {len(captured)}")

    st, r = call("POST", f"{ADMIN}/api/batch/build")
    check("rebuilding excludes families already emailed",
          r.get("skippedAlreadySent") == 2, str(r)[:220])

    print("\n=== 7. a withdrawn family is never mailed ===")
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_feedback",
                 "DELETE FROM eval_notes_internal", "DELETE FROM registrations",
                 "DELETE FROM players", "DELETE FROM email_budget"]:
        sql(stmt)
    register("Charlie Player", "charlie-parent@example.com", "10.63.0.1")
    C = reg_id("Charlie Player")
    call("POST", f"{ADMIN}/api/eval/{C}", {
        "strengths": "CHARLIEMARKER competed on every possession.",
        "growth_area": "CHARLIEGROWTH should use his left more.",
    })
    call("POST", f"{ADMIN}/api/decision/{C}", {"decision": "accept"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    BATCH2 = r.get("batchId")
    call("POST", f"{ADMIN}/api/message/{msg_id(C)}/review")
    call("POST", f"{ADMIN}/api/batch/{BATCH2}/approve")

    call("POST", f"{ADMIN}/api/registration/{C}/cancel", {"reason": "Family withdrew."})
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{BATCH2}/send")
    check("nothing is sent to a withdrawn family", len(captured) == 0, f"sink got {len(captured)}")
    out = _wrangler(f"SELECT send_state, last_error FROM parent_messages WHERE registration_id={C}")
    check("their message is retired, not left queued forever",
          '"send_state": "skipped"' in out, out[-300:])
    check("and it says why", "cancelled after approval" in out, out[-300:])

    print("\n=== 8. the last gate: notes changed between approve and send ===")
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_feedback",
                 "DELETE FROM registrations", "DELETE FROM players", "DELETE FROM email_budget"]:
        sql(stmt)
    register("Delta Player", "delta-parent@example.com", "10.64.0.1")
    D = reg_id("Delta Player")
    call("POST", f"{ADMIN}/api/eval/{D}", {
        "strengths": "DELTAMARKER originally written about the wrong child.",
        "growth_area": "DELTAGROWTH placeholder.",
    })
    call("POST", f"{ADMIN}/api/decision/{D}", {"decision": "accept"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    BATCH3 = r.get("batchId")
    call("POST", f"{ADMIN}/api/message/{msg_id(D)}/review")
    call("POST", f"{ADMIN}/api/batch/{BATCH3}/approve")

    # Approve and send can be days apart on the free tier, so the drain must not
    # trust approval. Change the notes in that window.
    sql(f"UPDATE eval_feedback SET strengths='CORRECTED text for the right child.', "
        f"updated_at=datetime('now','+1 minute') WHERE registration_id={D}")
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{BATCH3}/send")
    check("the drain refuses to send it", len(captured) == 0, f"sink got {len(captured)}")
    out = _wrangler(f"SELECT send_state, last_error FROM parent_messages WHERE registration_id={D}")
    check("it is marked failed, visibly, not silently skipped",
          '"send_state": "failed"' in out, out[-300:])
    check("and the reason names the change", "changed after approval" in out, out[-300:])

    print("\n=== 9. reopening: send messages back a step ===")
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_feedback",
                 "DELETE FROM registrations", "DELETE FROM players", "DELETE FROM email_budget"]:
        sql(stmt)
    register("Echo Player", "echo-parent@example.com", "10.65.0.1")
    register("Fox Player", "fox-parent@example.com", "10.66.0.1")
    E, F = reg_id("Echo Player"), reg_id("Fox Player")
    for rid, mark in ((E, "ECHOMARK"), (F, "FOXMARK")):
        call("POST", f"{ADMIN}/api/eval/{rid}", {
            "strengths": f"{mark} competed hard on every possession all morning.",
            "growth_area": f"{mark} should use the left hand far more often.",
        })
        call("POST", f"{ADMIN}/api/decision/{rid}", {"decision": "accept"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    RB = r.get("batchId")
    for rid in (E, F):
        call("POST", f"{ADMIN}/api/message/{msg_id(rid)}/review")
    call("POST", f"{ADMIN}/api/batch/{RB}/approve")

    out = _wrangler(f"SELECT send_state FROM parent_messages WHERE batch_id='{RB}'")
    check("both are queued after approval", out.count('"send_state": "queued"') == 2, out[-250:])

    # The whole point: something came up and the text has to change.
    st, r = call("POST", f"{ADMIN}/api/batch/{RB}/reopen")
    check("reopening the whole batch succeeds", st == 200 and r.get("ok"), str(r)[:200])
    check("it reports how many came back", r.get("reopened") == 2, str(r))

    out = _wrangler(f"SELECT send_state, reviewed_at FROM parent_messages WHERE batch_id='{RB}'")
    check("both are drafts again", out.count('"send_state": "draft"') == 2, out[-250:])
    check("and must be read again", out.count('"reviewed_at": null') == 2, out[-250:])
    out = _wrangler(f"SELECT state FROM decision_batches WHERE id='{RB}'")
    check("the batch reopened too", '"state": "draft"' in out, out[-200:])

    st, r = call("POST", f"{ADMIN}/api/batch/{RB}/send")
    check("a reopened batch cannot send", st == 400 and not r.get("ok"), str(r)[:200])

    print("\n=== 10. reopening a SELECTION, not everyone ===")
    for rid in (E, F):
        call("POST", f"{ADMIN}/api/message/{msg_id(rid)}/review")
    call("POST", f"{ADMIN}/api/batch/{RB}/approve")
    only = int(re.search(r'"id":\s*(\d+)', _wrangler(
        f"SELECT id FROM parent_messages WHERE registration_id={E}")).group(1))
    st, r = call("POST", f"{ADMIN}/api/batch/{RB}/reopen", {"message_ids": [only]})
    check("only the selected message reopens", st == 200 and r.get("reopened") == 1, str(r)[:200])
    out = _wrangler(f"SELECT registration_id, send_state FROM parent_messages WHERE batch_id='{RB}'")
    check("the other stays approved", '"send_state": "queued"' in out, out[-300:])
    check("and the reopened one is a draft", '"send_state": "draft"' in out, out[-300:])

    print("\n=== 11. a sent message can never be reopened ===")
    for rid in (E,):
        call("POST", f"{ADMIN}/api/message/{msg_id(rid)}/review")
    call("POST", f"{ADMIN}/api/batch/{RB}/approve")
    captured.clear()
    call("POST", f"{ADMIN}/api/batch/{RB}/send")
    check("they sent", len(captured) == 2, f"sink got {len(captured)}")
    st, r = call("POST", f"{ADMIN}/api/batch/{RB}/reopen")
    check("reopening after sending is refused", st == 400 and not r.get("ok"), str(r)[:220])
    check("and it says they are already sent", "sent" in str(r).lower(), str(r)[:220])

    print("\n=== 12. a failed send is retried, not abandoned ===")
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_feedback",
                 "DELETE FROM registrations", "DELETE FROM players", "DELETE FROM email_budget"]:
        sql(stmt)
    register("Golf Player", "golf-parent@example.com", "10.67.0.1")
    G = reg_id("Golf Player")
    call("POST", f"{ADMIN}/api/eval/{G}", {
        "strengths": "GOLFMARK competed hard on every possession.",
        "growth_area": "GOLFMARK should use the left more.",
    })
    call("POST", f"{ADMIN}/api/decision/{G}", {"decision": "accept"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    FB = r.get("batchId")
    call("POST", f"{ADMIN}/api/message/{msg_id(G)}/review")
    call("POST", f"{ADMIN}/api/batch/{FB}/approve")

    # Simulate a provider failure that already happened, e.g. a rate limit.
    sql(f"UPDATE parent_messages SET send_state='failed', send_attempts=1, "
        f"last_error='rate limited' WHERE registration_id={G}")
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{FB}/send")
    check("a failed message is retried on the next send", len(captured) == 1, f"sink got {len(captured)}")
    out = _wrangler(f"SELECT send_state FROM parent_messages WHERE registration_id={G}")
    check("and it lands as sent", '"send_state": "sent"' in out, out[-200:])

    print("\n=== 13. a message stranded mid-send is reclaimed, not lost ===")
    sql(f"UPDATE parent_messages SET send_state='sending', send_attempts=1 WHERE registration_id={G}")
    sql(f"UPDATE decision_batches SET state='sending' WHERE id='{FB}'")
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{FB}/send")
    # A tab closed mid-drain used to leave this row invisible forever while the
    # batch reported itself finished.
    check("the stranded message is picked back up", len(captured) == 1, f"sink got {len(captured)}")
    out = _wrangler(f"SELECT send_state FROM parent_messages WHERE registration_id={G}")
    check("and resolves", '"send_state": "sent"' in out, out[-200:])

finally:
    server.shutdown()

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
