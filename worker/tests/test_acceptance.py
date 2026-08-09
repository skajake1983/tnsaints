"""Local acceptance tests for the Tennessee Saints registration API."""
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

NATO = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India",
        "Juliet","Kilo","Lima","Mike","November","Oscar","Papa","Quebec","Romeo",
        "Sierra","Tango","Uniform","Victor","Whiskey","Xray","Yankee","Zulu"]

passed, failed = [], []


def call(method, path, body=None, origin=ORIGIN, ip=None, auth=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    if ip:
        req.add_header("CF-Connecting-IP", ip)
    if auth:
        req.add_header("Authorization", "Bearer " + auth)
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


def payload(name, email, session="9:00 AM", **over):
    p = {
        "session_time": session,
        "player_name": name,
        "grade": "5th",
        "years_experience": 3,
        "parent_name": "Parent " + name.split()[-1],
        "parent_email": email,
        "phone": "(615) 555-0100",
        "school": "Franklin Elementary",
        "emergency_contact_name": "Emergency Contact",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Automated acceptance test registration entry.",
        "medical_notes": "No known allergies.",
        "assumption_of_risk": True,
        "medical_release": True,
        "photo_release": True,
        "signature": "Parent Guardian",
        "turnstile_token": "dummy-token",
    }
    p.update(over)
    return p


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail and not cond else ""))


print("\n=== 1. availability on empty database ===")
st, av = call("GET", "/api/availability")
check("availability returns 200", st == 200, str(av))
check("registration window is open", av.get("registration_open") is True, str(av))
check("two sessions exposed", len(av.get("sessions", [])) == 2, str(av))
check("each session starts open", all(not s["full"] for s in av.get("sessions", [])), str(av))
# Exact counts must NOT be public — they belong to the admin endpoint only.
check("public availability hides taken/remaining/capacity",
      all(not {"taken", "remaining", "capacity"} & set(s) for s in av.get("sessions", [])), str(av))

print("\n=== 2. fill the 9:00 AM session to capacity (25) ===")
confirmed = 0
for i, n in enumerate(NATO[:25]):
    st, r = call("POST", "/api/register",
                 payload(f"Player {n}", f"parent{i}@example.com"), ip=f"10.0.{i}.1")
    if st == 200 and r.get("status") == "confirmed":
        confirmed += 1
    else:
        print(f"    unexpected at #{i+1}: {st} {r}")
check("all 25 registrations confirmed", confirmed == 25, f"got {confirmed}")

st, av = call("GET", "/api/availability")
nine = next(s for s in av["sessions"] if s["session_time"] == "9:00 AM")
ten = next(s for s in av["sessions"] if s["session_time"] == "10:00 AM")
check("9:00 AM reports full", nine["full"], str(nine))
check("10:00 AM unaffected, still open", not ten["full"], str(ten))

print("\n=== 2b. the register response must not leak counts either ===")
# Regression: /api/availability was fixed but the confirmed-registration
# response still returned capacity/taken/remaining, so anyone could read exact
# numbers simply by registering.
st, r = call("POST", "/api/register",
             payload("Leakcheck Player", "leakcheck@example.com", session="10:00 AM"),
             ip="10.7.0.1")
check("confirmed response hides exact counts",
      st == 200 and all(not {"taken", "remaining", "capacity"} & set(s)
                        for s in r.get("sessions", [])), str(r))

print("\n=== 3. the 26th registration overflows to the waitlist ===")
st, r = call("POST", "/api/register",
             payload("Player Zulu", "parent25@example.com"), ip="10.0.25.1")
check("26th returns 200", st == 200, str(r))
check("26th is waitlisted, not rejected", r.get("status") == "waitlist", str(r))
check("waitlist position reported", r.get("position") == 1, str(r))

print("\n=== 4. 10:00 AM still accepts while 9:00 AM is full ===")
st, r = call("POST", "/api/register",
             payload("Player Yankee", "parent26@example.com", session="10:00 AM"), ip="10.0.26.1")
check("10:00 AM registration confirmed", st == 200 and r.get("status") == "confirmed", str(r))

print("\n=== 5. duplicate player is rejected ===")
st, r = call("POST", "/api/register",
             payload("Player Alpha", "parent0@example.com"), ip="10.0.99.1")
check("duplicate returns 409", st == 409, str(r))

print("\n=== 6. bot and abuse controls ===")
st, r = call("POST", "/api/register",
             payload("Player Honeypot", "hp@example.com", company="Acme Corp"), ip="10.1.0.1")
check("honeypot submission rejected", st == 400, str(r))
check("honeypot reason not disclosed", "honeypot" not in json.dumps(r).lower(), str(r))

st, r = call("POST", "/api/register",
             payload("Player Fast", "fast@example.com", elapsed_ms=500), ip="10.1.0.2")
check("sub-3s submission rejected", st == 400, str(r))

st, r = call("POST", "/api/register",
             payload("Player Origin", "origin@example.com"), origin="https://evil.example.com", ip="10.1.0.3")
check("disallowed origin rejected", st == 403, str(r))

st, r = call("POST", "/api/register",
             payload("Player NoToken", "notoken@example.com", turnstile_token=""), ip="10.1.0.4")
check("missing turnstile token rejected", st == 403, str(r))

print("\n=== 7. rate limiting (same IP) ===")
codes = []
for i in range(5):
    st, r = call("POST", "/api/register",
                 payload(f"Ratelimit {NATO[i]}", f"rate{i}@example.com", session="10:00 AM"),
                 ip="203.0.113.77")
    codes.append(st)
check("rate limit kicks in within 5 attempts", 429 in codes, str(codes))
check("first attempts succeeded before limiting", codes[0] == 200, str(codes))

print("\n=== 8. field validation ===")
cases = [
    ("bad grade", {"grade": "13th"}),
    ("bad email", {"parent_email": "not-an-email"}),
    ("bad phone", {"phone": "12"}),
    ("notes too short", {"player_notes": "hi"}),
    ("years out of range", {"years_experience": 99}),
    ("unknown session", {"session_time": "11:00 AM"}),
    ("digits in player name", {"player_name": "Player 123"}),
]
for label, over in cases:
    st, r = call("POST", "/api/register",
                 payload("Player Valid", "valid@example.com", **over), ip="10.2.0.1")
    check(f"rejects {label}", st == 400, f"{st} {r}")

print("\n=== 8b. waiver acknowledgements ===")
waiver_cases = [
    ("missing assumption of risk", {"assumption_of_risk": False}),
    ("missing medical release", {"medical_release": False}),
    ("missing signature", {"signature": ""}),
    ("signature with digits", {"signature": "Parent 123"}),
    ("truthy-but-not-true risk value", {"assumption_of_risk": "yes"}),
]
for label, over in waiver_cases:
    st, r = call("POST", "/api/register",
                 payload("Player Waiver", "waiver@example.com", session="10:00 AM", **over),
                 ip="10.3.0.1")
    check(f"rejects {label}", st == 400, f"{st} {r}")

# Photo release is optional consent, so declining must still register.
st, r = call("POST", "/api/register",
             payload("Player Nophoto", "nophoto@example.com", session="10:00 AM",
                     photo_release=False),
             ip="10.3.1.1")
check("declining photo release still registers", st == 200 and r.get("ok"), str(r))

print("\n=== 9. admin export ===")
st, r = call("GET", "/api/admin/registrations")
check("export without token is 401", st == 401, str(r))
st, r = call("GET", "/api/admin/registrations", auth="wrong-token")
check("export with wrong token is 401", st == 401, str(r))
st, r = call("GET", "/api/admin/registrations", auth="local-dev-admin-token")
check("export with valid token is 200", st == 200, str(r)[:200])
if st == 200:
    regs = r.get("registrations", [])
    conf9 = [x for x in regs if x["session_time"] == "9:00 AM" and x["status"] == "confirmed"]
    wait9 = [x for x in regs if x["session_time"] == "9:00 AM" and x["status"] == "waitlist"]
    check("exactly 25 confirmed at 9:00 AM", len(conf9) == 25, f"got {len(conf9)}")
    check("waitlist rows present at 9:00 AM", len(wait9) >= 1, f"got {len(wait9)}")
    check("export omits ip_hash", all("ip_hash" not in x for x in regs), "ip_hash leaked")
    # A cancel token cancels a family's place with no other credential, so the
    # default projection must not hand one out per row to everyone with export
    # access.
    check("export omits cancel_token by default",
          all("cancel_token" not in x for x in regs), "cancel_token leaked")

st, r = call("GET", "/api/admin/registrations?include=cancel_token", auth="local-dev-admin-token")
check("cancel_token available when explicitly requested",
      st == 200 and all("cancel_token" in x for x in r.get("registrations", [])), str(r)[:160])

st, r = call("GET", "/api/admin/registrations?format=csv", auth="local-dev-admin-token")
check("csv export works", st == 200 and isinstance(r, str) and "player_name" in r, str(r)[:120])

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
