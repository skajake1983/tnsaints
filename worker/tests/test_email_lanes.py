"""The email budget: lanes, the monthly guard, refunds (src/email-budget.js).

Resend's free plan allows 100 emails a day and 3,000 a month, counted per
recipient. These checks pin down who may spend the last credits, and that a
send which does not happen costs nothing:

  - a send refused for budget leaves the counter untouched (it used to burn a
    credit on every refusal, so a stalled day drifted further past its limit)
  - parent receipts stop EMAIL_ALERT_RESERVE short of the limit; alerts and
    batches may use it all (until EMAIL_AUTH_RESERVE is raised for sign-in links)
  - a rolling 31-day window caps every lane but auth at the monthly limit
  - a provider failure refunds its credit
  - a decision batch that runs out of budget stops cleanly, leaves the rest
    queued, and the preflight said so beforehand
  - staff invites are metered

Mail goes to a loopback sink this file starts; nothing leaves the machine.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email, _dev_vars

BASE = "http://127.0.0.1:8787"
preflight(BASE)

ADMIN = "/__admin"
ORIGIN = "https://tnsaints.com"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ME = staff_email()
SINK_PORT = 8799

passed, failed = [], []
captured = []
sink_failures = {"remaining": 0}

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


# --- the numbers under test, read from config rather than restated -----------
def _toml_var(name):
    text = open(os.path.join(WORKER_DIR, "wrangler.toml"), encoding="utf-8").read()
    m = re.search(rf'^{name}\s*=\s*"(\d+)"', text, re.M)
    return int(m.group(1)) if m else None


def _setting(name):
    local = _dev_vars().get(name)
    return int(local) if local not in (None, "") else _toml_var(name)


L = _setting("EMAIL_DAILY_LIMIT")
R = _setting("EMAIL_ALERT_RESERVE")
A = _setting("EMAIL_AUTH_RESERVE")
M = _setting("EMAIL_MONTHLY_LIMIT")
MA = _setting("EMAIL_MONTHLY_AUTH_RESERVE")
if None in (L, R, A, M, MA) or L < max(R, A) + 10:
    sys.exit("\nREFUSING TO RUN.\n  This suite needs the email budget settings in wrangler.toml, and a local\n"
             "  EMAIL_DAILY_LIMIT comfortably above EMAIL_ALERT_RESERVE (mail goes to the\n"
             "  loopback sink, so a generous local limit costs nothing).\n")


class Sink(BaseHTTPRequestHandler):
    """Stands in for Resend. Can be told to fail the next N sends with a 500."""

    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        if sink_failures["remaining"] > 0:
            sink_failures["remaining"] -= 1
            body, status = b'{"message":"simulated provider outage"}', 500
        else:
            try:
                captured.append(json.loads(raw))
            except json.JSONDecodeError:
                captured.append({"unparseable": raw[:400]})
            body, status = json.dumps({"id": f"sink-{len(captured)}"}).encode(), 200
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def sql(command):
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "tnsaints", "--local", "--command", command],
        capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR,
    )
    return (res.stdout or b"").decode("utf-8", errors="replace")


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
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


_ip = [0]


def register(name):
    """A registration fires the academy alert (alert lane) then the parent receipt (receipt lane)."""
    _ip[0] += 1
    slug = name.lower().replace(" ", "-")
    req_body = {
        "session_time": "9:00 AM", "player_name": name, "grade": "5th",
        "years_experience": 2, "parent_name": f"Parent of {name}",
        "parent_email": f"{slug}@example.com", "phone": "(615) 555-0100",
        "school": "Franklin Elementary", "emergency_contact_name": "EC",
        "emergency_contact_phone": "(615) 555-0199", "medical_notes": "",
        "player_notes": "Registration created for the email budget tests.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "d", "elapsed_ms": 9000,
    }
    req = urllib.request.Request(BASE + "/api/register", data=json.dumps(req_body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", ORIGIN)
    req.add_header("CF-Connecting-IP", f"10.88.{_ip[0] // 250}.{_ip[0] % 250 + 1}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def settle(expected_at_least=0, timeout=6.0):
    """Registration mail goes out in waitUntil(), after the response. Wait for it to land."""
    deadline = time.time() + timeout
    last, stable_since = -1, time.time()
    while time.time() < deadline:
        n = len(captured)
        if n != last:
            last, stable_since = n, time.time()
        elif n >= expected_at_least and time.time() - stable_since > 1.2:
            return
        time.sleep(0.1)


def today_sent():
    m = re.search(r'"sent":\s*(\d+)', sql("SELECT sent FROM email_budget WHERE day = date('now')"))
    return int(m.group(1)) if m else 0


def set_budget(today=None, rows=()):
    """Replace the budget table: `today` credits used today, plus (days_ago, sent) rows."""
    stmts = ["DELETE FROM email_budget;"]
    if today is not None:
        stmts.append(f"INSERT INTO email_budget (day, sent) VALUES (date('now'), {int(today)});")
    for days_ago, sent in rows:
        stmts.append(f"INSERT INTO email_budget (day, sent) VALUES (date('now', '-{int(days_ago)} days'), {int(sent)});")
    sql(" ".join(stmts))


def to_parent(msg):
    return any("@example.com" in t for t in (msg.get("to") or []))


def run_registration(name, today=None, rows=()):
    set_budget(today, rows)
    captured.clear()
    st = register(name)
    settle()
    alerts = [m for m in captured if not to_parent(m)]
    receipts = [m for m in captured if to_parent(m)]
    return st, len(alerts), len(receipts)


server = ThreadingHTTPServer(("127.0.0.1", SINK_PORT), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"\n  local mail sink listening on 127.0.0.1:{SINK_PORT} — nothing leaves this machine")

try:
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions", "DELETE FROM decision_batches",
                 "DELETE FROM eval_notes_internal", "DELETE FROM eval_feedback", "DELETE FROM registrations",
                 "DELETE FROM players", "DELETE FROM email_budget", "DELETE FROM staff"]:
        sql(stmt)
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

    print("\n=== 1. an ample budget sends both, and charges exactly two ===")
    st, alerts, receipts = run_registration("Lane Ample", today=0)
    check("registration accepted", st == 200, f"got {st}")
    check("the academy alert and the parent receipt both went", (alerts, receipts) == (1, 1), (alerts, receipts))
    check("two credits charged", today_sent() == 2, today_sent())

    print("\n=== 2. a refused send changes nothing ===")
    st, alerts, receipts = run_registration("Lane Full", today=L)
    check("the registration itself still succeeds", st == 200, f"got {st}")
    check("nothing is sent once the day is spent", (alerts, receipts) == (0, 0), (alerts, receipts))
    check("and the counter stays exactly at the limit (it used to climb on every refusal)",
          today_sent() == L, today_sent())

    print("\n=== 3. alerts may spend the last credit; receipts stop at the reserve ===")
    st, alerts, receipts = run_registration("Lane Last Credit", today=L - 1)
    check("the alert takes the final credit", alerts == 1, alerts)
    check("the receipt is held back", receipts == 0, receipts)
    check("counter lands exactly on the limit", today_sent() == L, today_sent())

    receipt_ceiling = L - max(R, A)
    st, alerts, receipts = run_registration("Lane Reserve Edge", today=receipt_ceiling - 1)
    check("one credit below the receipt ceiling: the alert goes", alerts == 1, alerts)
    check("and the receipt, which would cross the ceiling, does not", receipts == 0, receipts)
    check("counter shows only the alert was charged", today_sent() == receipt_ceiling, today_sent())

    st, alerts, receipts = run_registration("Lane Receipt Fits", today=receipt_ceiling - 2)
    check("two below the receipt ceiling: both go", (alerts, receipts) == (1, 1), (alerts, receipts))
    check("and the receipt lands exactly on its ceiling", today_sent() == receipt_ceiling, today_sent())

    print("\n=== 4. the monthly guard (rolling 31 days, today included) ===")
    month_ceiling = M - MA
    st, alerts, receipts = run_registration("Lane Month Edge", today=0, rows=[(10, month_ceiling - 1)])
    check("one credit left this month: the alert takes it", alerts == 1, alerts)
    check("and the receipt is refused on the monthly cap, not the daily one", receipts == 0, receipts)
    check("refusal left the counter alone", today_sent() == 1, today_sent())

    st, alerts, receipts = run_registration("Lane Month Inside", today=0, rows=[(30, 5000)])
    check("a heavy day 30 days ago is still inside the window: nothing sends",
          (alerts, receipts) == (0, 0), (alerts, receipts))

    st, alerts, receipts = run_registration("Lane Month Outside", today=0, rows=[(31, 5000)])
    check("the same day 31 days ago has aged out: both send", (alerts, receipts) == (1, 1), (alerts, receipts))

    print("\n=== 5. a provider failure refunds its credit ===")
    set_budget(today=0)
    captured.clear()
    sink_failures["remaining"] = 2
    register("Lane Outage")
    time.sleep(2.5)
    check("both sends hit the simulated outage", sink_failures["remaining"] == 0, sink_failures)
    check("and neither kept its credit", today_sent() == 0, today_sent())
    sink_failures["remaining"] = 0

    print("\n=== 6. a decision batch that runs out stops cleanly, and preflight warned first ===")
    # A batch covers every registration for the event, and approval needs a
    # decision on each -- so start from an empty roster, not the players above.
    for stmt in ["DELETE FROM parent_messages", "DELETE FROM decisions", "DELETE FROM decision_batches",
                 "DELETE FROM eval_notes_internal", "DELETE FROM eval_feedback",
                 "DELETE FROM registrations", "DELETE FROM players"]:
        sql(stmt)
    names = ["Lane Batch One", "Lane Batch Two"]
    ids = []
    for nm in names:
        register(nm)
        m = re.search(r'"id":\s*(\d+)', sql(f"SELECT id FROM registrations WHERE player_name='{nm}'"))
        ids.append(int(m.group(1)))
    settle()
    for rid in ids:
        call("POST", f"{ADMIN}/api/eval/{rid}", {
            "strengths": "LANEMARK competed hard on every possession all morning.",
            "growth_area": "LANEMARK should use the left hand far more often.",
        })
        call("POST", f"{ADMIN}/api/decision/{rid}", {"decision": "accept"})
    st, r = call("POST", f"{ADMIN}/api/batch/build")
    batch = r.get("batchId") if isinstance(r, dict) else None
    check("batch built", bool(batch), str(r)[:200])
    for mid in re.findall(r'"id":\s*(\d+)', sql(f"SELECT id FROM parent_messages WHERE batch_id='{batch}'")):
        call("POST", f"{ADMIN}/api/message/{mid}/review")
    st, r = call("POST", f"{ADMIN}/api/batch/{batch}/approve")
    check("batch approved", st == 200 and r.get("ok"), str(r)[:200])

    set_budget(today=L - 1)
    st, pre = call("GET", f"{ADMIN}/api/batch/{batch}/preflight")
    check("preflight shows the bulk ceiling as the limit", pre.get("budget_limit") == L - A, pre)
    check("preflight shows one credit left", pre.get("budget_remaining") == 1, pre)
    check("and says it is not enough, short by one",
          pre.get("enough") is False and pre.get("shortfall") == 1, pre)

    captured.clear()
    call("POST", f"{ADMIN}/api/batch/{batch}/send")
    settle(expected_at_least=1)
    check("exactly one message went", len(captured) == 1, len(captured))
    states = sql(f"SELECT send_state, last_error FROM parent_messages WHERE batch_id='{batch}' ORDER BY id")
    check("one is sent", states.count('"send_state": "sent"') == 1, states[-300:])
    check("the other waits in the queue, marked budget -- not failed",
          states.count('"send_state": "queued"') == 1 and '"last_error": "budget"' in states
          and '"send_state": "failed"' not in states, states[-300:])
    check("the refusal did not push the counter past the limit", today_sent() == L, today_sent())

    set_budget(today=0, rows=[(5, month_ceiling - 3)])
    st, pre = call("GET", f"{ADMIN}/api/batch/{batch}/preflight")
    check("preflight reports the tighter of daily and monthly headroom", pre.get("budget_remaining") == 3, pre)

    set_budget(today=0)
    captured.clear()
    call("POST", f"{ADMIN}/api/batch/{batch}/send")
    settle(expected_at_least=1)
    check("with budget back, the queued message goes the next time", len(captured) == 1, len(captured))

    print("\n=== 7. staff invites are metered ===")
    set_budget(today=L)
    captured.clear()
    st, r = call("POST", f"{ADMIN}/api/staff/reinvite", {"email": ME})
    time.sleep(1)
    check("a reinvite on a spent day is refused", st == 429 and r.get("ok") is False, f"{st} {str(r)[:160]}")
    check("with a message that says why", "allowance" in str(r).lower(), str(r)[:200])
    check("nothing reached the sink", len(captured) == 0, len(captured))
    check("counter unchanged", today_sent() == L, today_sent())

    set_budget(today=0)
    st, r = call("POST", f"{ADMIN}/api/staff/reinvite", {"email": ME})
    time.sleep(1)
    check("with budget, the reinvite sends", st == 200 and r.get("ok"), f"{st} {str(r)[:160]}")
    check("and costs one credit", today_sent() == 1, today_sent())

finally:
    server.shutdown()

print("\n=== 8. the numbers themselves (src/email-budget.js, imported directly) ===")
UNIT = r"""
import { budgetLimits, reserveSend, recipientCount, LANES } from './src/email-budget.js';
const lanes = (env) => { const l = budgetLimits(env).lanes;
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, [v.daily, v.monthly]])); };
let unknownThrows = false;
try { await reserveSend({ DB: null }, { lane: 'nope' }); } catch (e) { unknownThrows = e instanceof TypeError; }
let missingThrows = false;
try { await reserveSend({ DB: null }, {}); } catch (e) { missingThrows = e instanceof TypeError; }
console.log(JSON.stringify({
  today: lanes({ EMAIL_DAILY_LIMIT: '100', EMAIL_ALERT_RESERVE: '25', EMAIL_AUTH_RESERVE: '0',
                 EMAIL_MONTHLY_LIMIT: '3000', EMAIL_MONTHLY_AUTH_RESERVE: '150' }),
  portal: lanes({ EMAIL_DAILY_LIMIT: '100', EMAIL_ALERT_RESERVE: '25', EMAIL_AUTH_RESERVE: '15' }),
  big_auth: lanes({ EMAIL_DAILY_LIMIT: '100', EMAIL_ALERT_RESERVE: '10', EMAIL_AUTH_RESERVE: '30' }),
  zero: lanes({ EMAIL_DAILY_LIMIT: '0' }),
  defaults: lanes({}),
  garbage: lanes({ EMAIL_DAILY_LIMIT: 'lots', EMAIL_ALERT_RESERVE: '-4' }),
  lanes: LANES,
  unknownThrows, missingThrows,
  recipients: [recipientCount('a@x.com'), recipientCount(['a@x.com', 'b@x.com']), recipientCount([]),
               recipientCount(undefined)],
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-400:])
if u:
    check("today's settings (auth reserve 0) reproduce the pre-lane ceilings",
          u["today"] == {"auth": [100, 3000], "alert": [100, 2850], "bulk": [100, 2850], "receipt": [75, 2850]},
          u["today"])
    check("a 15/day auth reserve takes 15 from alerts and batches, not from receipts' own reserve",
          u["portal"] == {"auth": [100, 3000], "alert": [85, 2850], "bulk": [85, 2850], "receipt": [75, 2850]},
          u["portal"])
    check("receipts always leave at least the auth reserve",
          u["big_auth"]["receipt"] == [70, 2850], u["big_auth"])
    check("EMAIL_DAILY_LIMIT=0 means zero, not the default",
          all(v[0] <= 0 for v in u["zero"].values()), u["zero"])
    check("unset settings take the free-plan defaults",
          u["defaults"] == {"auth": [100, 3000], "alert": [100, 2850], "bulk": [100, 2850], "receipt": [75, 2850]},
          u["defaults"])
    check("unreadable or negative settings fall back to the defaults", u["garbage"] == u["defaults"], u["garbage"])
    check("the four lanes", u["lanes"] == ["auth", "alert", "bulk", "receipt"], u["lanes"])
    check("an unknown lane is a loud error, never an unmetered send", u["unknownThrows"] is True)
    check("so is a missing lane", u["missingThrows"] is True)
    check("recipients are counted per address (Resend bills per recipient)",
          u["recipients"] == [1, 2, 1, 1], u["recipients"])

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
sys.exit(1 if failed else 0)
