"""Siblings, twins, and children whose names are ordinary words.

Player identity is keyed on (parent_email_norm, name_norm), so a family with two
children in the same event is the case most likely to collapse two people into
one record -- and the consequence is a parent receiving one child's feedback
about the other, from the same address, on the same morning.

The second half is the mirror image: the guard that stops another child's
message being pasted into a draft works by looking for other players' names. A
child called Grace, Will, Chase, Hope or Mark makes that a word which appears in
ordinary sentences, so the guard can refuse a message that is perfectly correct.
On send day that reads as the system being broken.
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
        pass


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


def register(name, email, ip, session="9:00 AM"):
    return call("POST", "/api/register", {
        "session_time": session, "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": "Dana Reed",
        "parent_email": email, "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Registration created for the sibling identity tests.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Dana Reed", "turnstile_token": "d",
    })


def reg_id(name):
    out = _wrangler(f"SELECT id FROM registrations WHERE player_name='{name}' ORDER BY id DESC LIMIT 1")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


def msg_id(rid):
    out = _wrangler(f"SELECT id FROM parent_messages WHERE registration_id={rid} AND send_state='draft'")
    m = re.search(r'"id":\s*(\d+)', out)
    return int(m.group(1)) if m else None


def wipe():
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions",
                 "DELETE FROM decision_batches", "DELETE FROM eval_notes_internal",
                 "DELETE FROM eval_feedback", "DELETE FROM registrations",
                 "DELETE FROM players", "DELETE FROM email_budget"]:
        sql(stmt)


server = ThreadingHTTPServer(("127.0.0.1", SINK_PORT), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    sql("DELETE FROM staff")
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    print("\n=== 1. twins under one parent email are two separate people ===")
    wipe()
    HOME = "reed-family@example.com"
    st1, _ = register("Marcus Reed", HOME, "10.81.0.1")
    st2, _ = register("Mara Reed", HOME, "10.81.0.2", session="10:00 AM")
    check("both twins register", st1 == 200 and st2 == 200, f"{st1} {st2}")

    M, A = reg_id("Marcus Reed"), reg_id("Mara Reed")
    check("they are two registrations", M and A and M != A, f"{M} {A}")

    # Identity is (parent_email_norm, name_norm). One shared email must not
    # collapse two children into one person.
    call("POST", f"{ADMIN}/api/eval/{M}", {"strengths": "MARCUSMARK read the floor well.",
                                           "growth_area": "MARCUSGROW use the left hand."})
    call("POST", f"{ADMIN}/api/eval/{A}", {"strengths": "MARAMARK finished through contact.",
                                           "growth_area": "MARAGROW talk on defence."})
    out = _wrangler("SELECT COUNT(*) AS n FROM players")
    check("two player records, not one", '"n": 2' in out, out[-200:])

    out = _wrangler(f"SELECT player_id FROM registrations WHERE id IN ({M},{A})")
    ids = re.findall(r'"player_id":\s*(\d+)', out)
    check("each registration points at its own player", len(set(ids)) == 2, str(ids))

    print("\n=== 2. each twin's message carries only their own feedback ===")
    call("POST", f"{ADMIN}/api/decision/{M}", {"decision": "accept"})
    call("POST", f"{ADMIN}/api/decision/{A}", {"decision": "not_yet"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    TB = r.get("batchId")
    check("both compose", r.get("composed") == 2, str(r)[:200])

    m_body = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={M}")
    a_body = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={A}")
    check("Marcus's message has Marcus's observation", "MARCUSMARK" in m_body, m_body[-200:])
    check("and none of Mara's", "MARAMARK" not in m_body)
    check("Mara's message has Mara's observation", "MARAMARK" in a_body, a_body[-200:])
    check("and none of Marcus's", "MARCUSMARK" not in a_body)

    print("\n=== 3. the parent can tell the two apart ===")
    subs = re.findall(r'"subject":\s*"([^"]+)"', _wrangler("SELECT subject FROM parent_messages"))
    check("two subject lines", len(subs) == 2, str(subs))
    # Both land in one inbox, minutes apart, from one sender. If the subjects
    # were identical the parent could not tell which child each concerns.
    check("the subjects differ", len(set(subs)) == 2, str(subs))
    check("each names its own child",
          any("Marcus" in s for s in subs) and any("Mara" in s for s in subs), str(subs))
    check("neither subject reveals the outcome",
          not any(w in " ".join(subs).lower() for w in ["accept", "not selected", "rejected"]), str(subs))

    print("\n=== 4. both actually arrive, at the same address, unswapped ===")
    for rid in (M, A):
        call("POST", f"{ADMIN}/api/message/{msg_id(rid)}/review")
    st, r = call("POST", f"{ADMIN}/api/batch/{TB}/approve")
    check("approved", st == 200 and r.get("ok"), str(r)[:200])
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/batch/{TB}/send")
    check("both were sent", r.get("sent") == 2, str(r)[:200])
    check("the sink received two", len(captured) == 2, str(len(captured)))

    to_addrs = []
    for p in captured:
        t = p.get("to")
        to_addrs.append(t[0] if isinstance(t, list) else t)
    check("both went to the one family address", to_addrs == [HOME, HOME], str(to_addrs))

    marcus_mail = next((json.dumps(p) for p in captured if "MARCUSMARK" in json.dumps(p)), "")
    mara_mail = next((json.dumps(p) for p in captured if "MARAMARK" in json.dumps(p)), "")
    check("one email is Marcus's", bool(marcus_mail))
    check("the other is Mara's", bool(mara_mail))
    check("Marcus's email says nothing about Mara", "MARAMARK" not in marcus_mail)
    check("Mara's email says nothing about Marcus", "MARCUSMARK" not in mara_mail)

    print("\n=== 5. a child whose name is an ordinary word ===")
    # Will, Grace, Chase, Hope, Mark, Drew. The other-child guard looks for
    # players' names in a message; if it matched these as words it would refuse
    # correct messages, which on send day reads as the system being broken.
    wipe()
    register("Will Turner", "will-parent@example.com", "10.82.0.1")
    register("Grace Palmer", "grace-parent@example.com", "10.82.0.2", session="10:00 AM")
    W, G = reg_id("Will Turner"), reg_id("Grace Palmer")
    for rid, mark in ((W, "WILLMARK"), (G, "GRACEMARK")):
        call("POST", f"{ADMIN}/api/eval/{rid}", {
            "strengths": f"{mark} competed hard all morning.",
            "growth_area": f"{mark} should use the left more.",
        })
        call("POST", f"{ADMIN}/api/decision/{rid}", {"decision": "accept"})
    call("POST", f"{ADMIN}/api/batch/build")
    wm = msg_id(W)

    st, r = call("POST", f"{ADMIN}/api/message/{wm}/edit", {
        "body_text": "Dear family, Will competed hard on Saturday and we think he will keep "
                     "improving quickly. He played with real grace under pressure and we would "
                     "love to have him. Please reply with any questions."})
    check("an ordinary word that happens to be another child's name is allowed",
          st == 200 and r.get("ok"), str(r)[:250])

    print("\n=== 6. but a genuinely pasted message is still caught ===")
    g_body = _wrangler(f"SELECT body_text FROM parent_messages WHERE registration_id={G}")
    m = re.search(r'"body_text":\s*"((?:[^"\\]|\\.)*)"', g_body)
    pasted = m.group(1).replace("\\n", " ") if m else ""
    st, r = call("POST", f"{ADMIN}/api/message/{wm}/edit", {"body_text": pasted})
    check("pasting Grace's whole message into Will's is REFUSED", st == 400, f"got {st} {str(r)[:200]}")

    print("\n=== 7. siblings do not trip the guard on each other ===")
    wipe()
    register("Marcus Reed", HOME, "10.83.0.1")
    register("Mara Reed", HOME, "10.83.0.2", session="10:00 AM")
    M, A = reg_id("Marcus Reed"), reg_id("Mara Reed")
    for rid, mark in ((M, "MARCUSMARK"), (A, "MARAMARK")):
        call("POST", f"{ADMIN}/api/eval/{rid}", {
            "strengths": f"{mark} competed hard all morning.",
            "growth_area": f"{mark} should use the left more.",
        })
        call("POST", f"{ADMIN}/api/decision/{rid}", {"decision": "accept"})
    call("POST", f"{ADMIN}/api/batch/build")
    st, r = call("POST", f"{ADMIN}/api/message/{msg_id(M)}/edit", {
        "body_text": "Dear family, Marcus competed hard on Saturday and we would love to have "
                     "him join us. Please reply to this email with any questions at all."})
    check("a normal message to one twin saves", st == 200 and r.get("ok"), str(r)[:250])

finally:
    server.shutdown()

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
