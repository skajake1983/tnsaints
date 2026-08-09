"""Cancellation flow tests."""
import json
import urllib.request
import urllib.error

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight


BASE = "http://127.0.0.1:8787"

preflight(BASE)
ORIGIN = "https://tnsaints.com"
ADMIN = "local-dev-admin-token"

passed, failed = [], []


def call(method, path, body=None, origin=ORIGIN, ip=None, auth=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    if ip:
        req.add_header("CF-Connecting-IP", ip)
    if auth:
        req.add_header("Authorization", "Bearer " + auth)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def payload(name, email, session="9:00 AM"):
    return {
        "session_time": session, "player_name": name, "grade": "5th",
        "years_experience": 3, "parent_name": "Parent Test", "parent_email": email,
        "phone": "(615) 555-0100", "school": "Franklin Elementary",
        "emergency_contact_name": "Emergency Contact",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Cancellation flow test registration entry.",
        "assumption_of_risk": True, "medical_release": True, "photo_release": True,
        "signature": "Parent Test", "turnstile_token": "dummy",
    }


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail and not cond else ""))


CAPACITY = 25


def confirmed_count(session="9:00 AM"):
    st, r = call("GET", "/api/admin/registrations", auth=ADMIN)
    return len([x for x in r.get("registrations", [])
                if x["session_time"] == session and x["status"] == "confirmed"])


def token_for(player):
    # Tokens are capabilities, so the export withholds them unless asked.
    st, r = call("GET", "/api/admin/registrations?include=cancel_token", auth=ADMIN)
    for x in r.get("registrations", []):
        if x["player_name"] == player:
            return x.get("cancel_token")
    return None


print("\n=== 1. registering issues a cancel token ===")
st, r = call("POST", "/api/register", payload("Cancel Alpha", "ca@example.com"), ip="10.20.0.1")
check("registration confirmed", st == 200 and r.get("status") == "confirmed", str(r))
tok = token_for("Cancel Alpha")
check("token is stored", bool(tok), "no token found")
check("token is 64 hex chars", bool(tok) and len(tok) == 64 and all(c in "0123456789abcdef" for c in tok),
      f"got {tok!r}")
check("token is NOT in the register response", "cancel_token" not in json.dumps(r), str(r))

print("\n=== 2. lookup is read-only (a mail scanner must not cancel anyone) ===")
before = confirmed_count()
st, r = call("GET", f"/api/cancel/lookup?t={tok}")
check("lookup returns 200", st == 200 and r.get("ok"), str(r))
check("lookup shows the player", r.get("player_name") == "Cancel Alpha", str(r))
# The critical assertion: fetching the link repeatedly must change nothing.
for _ in range(3):
    call("GET", f"/api/cancel/lookup?t={tok}")
check("repeated GETs do NOT cancel", confirmed_count() == before,
      f"count went {before} -> {confirmed_count()}")

print("\n=== 3. cancelling frees the spot ===")
st, r = call("POST", "/api/cancel", {"token": tok, "reason": "Family conflict that weekend."})
check("cancel returns 200", st == 200 and r.get("ok"), str(r))
check("spot is freed", confirmed_count() == before - 1, f"{before} -> {confirmed_count()}")

st, r = call("GET", "/api/admin/registrations", auth=ADMIN)
row = next((x for x in r["registrations"] if x["player_name"] == "Cancel Alpha"), None)
check("row is kept, not deleted", row is not None)
check("status is cancelled", row and row["status"] == "cancelled", str(row))
check("reason is stored", row and row.get("cancel_reason") == "Family conflict that weekend.", str(row))
check("cancelled_at is set", bool(row and row.get("cancelled_at")), str(row))

print("\n=== 4. double cancel is harmless ===")
st, r = call("POST", "/api/cancel", {"token": tok, "reason": "again"})
check("second cancel is idempotent", st == 200 and r.get("already_cancelled") is True, str(r))

print("\n=== 5. the same family can register again after cancelling ===")
st, r = call("POST", "/api/register", payload("Cancel Alpha", "ca@example.com"), ip="10.20.0.2")
check("re-registration allowed", st == 200 and r.get("status") == "confirmed", str(r))

print("\n=== 6. bad tokens ===")
for label, t in [("empty", ""), ("short", "abc"), ("wrong charset", "z" * 64),
                 ("valid shape but unknown", "a" * 64)]:
    st, r = call("GET", f"/api/cancel/lookup?t={t}")
    check(f"lookup rejects {label}", st == 404, f"{st} {r}")
    st, r = call("POST", "/api/cancel", {"token": t})
    check(f"cancel rejects {label}", st == 404, f"{st} {r}")

print("\n=== 7. cancel respects the origin allow-list ===")
tok2 = token_for("Cancel Alpha")
st, r = call("POST", "/api/cancel", {"token": tok2}, origin="https://evil.example.com")
check("foreign origin rejected", st == 403, str(r))

print("\n=== 8. a cancelled spot is genuinely re-claimable ===")
st, av = call("GET", "/api/availability")
check("availability still reports open", any(not s["full"] for s in av["sessions"]), str(av))

print("\n=== 9. auto-promotion: fill 10:00 AM, then cancel one ===")
SESSION = "10:00 AM"
WORDS = ["Ash","Birch","Cedar","Dogwood","Elm","Fir","Gum","Hickory","Ivy","Juniper",
         "Katsu","Larch","Maple","Nutmeg","Oak","Pine","Quince","Redwood","Spruce","Teak",
         "Umbra","Vine","Willow","Yew","Zelkova"]
for i, w in enumerate(WORDS[:25]):
    st, r = call("POST", "/api/register", payload(f"Full {w}", f"full{i}@example.com", SESSION),
                 ip=f"172.20.{i}.1")
    if st != 200 or r.get("status") != "confirmed":
        print(f"    unexpected filling #{i}: {st} {r}")

st, av = call("GET", "/api/availability")
sess = next(s for s in av["sessions"] if s["session_time"] == SESSION)
check("session is full", sess["full"] is True, str(sess))

# Two more join the waiting list, in a known order.
st, first = call("POST", "/api/register", payload("Waiting First", "w1@example.com", SESSION), ip="172.21.0.1")
check("first overflow is waitlisted", first.get("status") == "waitlist", str(first))
st, second = call("POST", "/api/register", payload("Waiting Second", "w2@example.com", SESSION), ip="172.21.0.2")
check("second overflow is waitlisted", second.get("status") == "waitlist", str(second))

# Cancel a confirmed seat; the earliest waitlisted family should take it.
tok_full = token_for("Full Ash")
st, r = call("POST", "/api/cancel", {"token": tok_full, "reason": "Testing promotion."})
check("cancel succeeded", st == 200 and r.get("ok"), str(r))

st, rr = call("GET", "/api/admin/registrations", auth=ADMIN)
rows = {x["player_name"]: x for x in rr["registrations"]}
check("earliest waitlisted was promoted", rows["Waiting First"]["status"] == "confirmed",
      f"got {rows['Waiting First']['status']}")
check("later waitlisted stayed waiting", rows["Waiting Second"]["status"] == "waitlist",
      f"got {rows['Waiting Second']['status']}")
check("cancelled row is cancelled", rows["Full Ash"]["status"] == "cancelled",
      f"got {rows['Full Ash']['status']}")

conf = len([x for x in rr["registrations"] if x["session_time"] == SESSION and x["status"] == "confirmed"])
check("session still exactly at capacity", conf == 25, f"got {conf}")

st, av = call("GET", "/api/availability")
sess = next(s for s in av["sessions"] if s["session_time"] == SESSION)
check("session still reports full after promotion", sess["full"] is True, str(sess))

print("\n=== 9b. waitlist position is per-session, not event-wide ===")
# Regression: position was counted across the whole event while promotion is
# per-session, so someone first in line for one session was told they were
# behind everyone queued for the other.
FIRST = "9:00 AM"
# Earlier sections already placed people in this session, so top it up to
# capacity rather than assuming it starts empty.
need_nine = CAPACITY - confirmed_count(FIRST)
for i in range(need_nine):
    w = WORDS[i % len(WORDS)] + ("x" * (i // len(WORDS)))
    st, r = call("POST", "/api/register", payload(f"Nine {w}", f"nine{i}@example.com", FIRST),
                 ip=f"172.30.{i}.1")
    if st != 200 or r.get("status") != "confirmed":
        print(f"    unexpected filling 9AM #{i}: {st} {r}")
check("9:00 AM is now exactly full", confirmed_count(FIRST) == CAPACITY,
      f"got {confirmed_count(FIRST)}")

# Three onto the 9:00 waitlist.
positions_nine = []
for i in range(3):
    st, r = call("POST", "/api/register",
                 payload(f"Ninewait {WORDS[i]}", f"nw{i}@example.com", FIRST), ip=f"172.31.{i}.1")
    positions_nine.append(r.get("position"))
check("9:00 AM waitlist positions run 1,2,3", positions_nine == [1, 2, 3], str(positions_nine))

# 10:00 AM is already full from section 9; the next one there must be told its
# own queue position, not a number inflated by the 9:00 AM queue.
st, r = call("POST", "/api/register",
             payload("Tenwait Solo", "tenwait@example.com", SESSION), ip="172.32.0.1")
check("10:00 AM waitlist counts only its own session",
      r.get("status") == "waitlist" and r.get("position") == 2,
      f"got position {r.get('position')} (2 expected: Waiting Second is still queued there)")

print("\n=== 10. cancelling a WAITLIST spot promotes nobody ===")
tok_w2 = token_for("Waiting Second")
before_conf = len([x for x in rr["registrations"] if x["session_time"] == SESSION and x["status"] == "confirmed"])
st, r = call("POST", "/api/cancel", {"token": tok_w2})
check("waitlist cancel succeeds", st == 200 and r.get("ok"), str(r))
st, rr2 = call("GET", "/api/admin/registrations", auth=ADMIN)
after_conf = len([x for x in rr2["registrations"] if x["session_time"] == SESSION and x["status"] == "confirmed"])
check("confirmed count unchanged", after_conf == before_conf, f"{before_conf} -> {after_conf}")

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
