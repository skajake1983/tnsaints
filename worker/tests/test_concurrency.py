"""Race test: many people submitting at the same instant for the last spot.

This is the claim that matters. If the capacity check and the insert were two
separate statements, several requests could each read "24 taken" and all
insert, overselling the session.
"""
import json
import urllib.request
import urllib.error
import threading

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight


BASE = "http://127.0.0.1:8787"

preflight(BASE)
SESSION = "10:00 AM"


def call(method, path, body=None, ip=None, auth=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Origin", "https://tnsaints.com")
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


def payload(name, email):
    return {
        "session_time": SESSION,
        "player_name": name,
        "grade": "5th",
        "years_experience": 2,
        "parent_name": "Race Parent",
        "parent_email": email,
        "phone": "(615) 555-0100",
        "school": "Franklin Elementary",
        "emergency_contact_name": "Emergency Contact",
        "emergency_contact_phone": "(615) 555-0199",
        "player_notes": "Concurrency test registration entry for the race check.",
        "medical_notes": "No known allergies.",
        "assumption_of_risk": True,
        "medical_release": True,
        "photo_release": True,
        "signature": "Race Parent",
        "turnstile_token": "dummy-token",
    }


WORDS = ["Ant","Bee","Cat","Doe","Elk","Fox","Gnu","Hen","Ibis","Jay",
         "Koi","Lark","Moth","Newt","Owl","Pig","Quail","Ram","Swan","Toad"]

CAPACITY = 25


def confirmed_count(session):
    """Exact counts are admin-only now; the public endpoint reports open/full."""
    st, r = call("GET", "/api/admin/registrations", auth="local-dev-admin-token")
    rows = r.get("registrations", [])
    return len([x for x in rows if x["session_time"] == session and x["status"] == "confirmed"])


# Top the session up to exactly one remaining spot.
taken = confirmed_count(SESSION)
need = CAPACITY - taken - 1
print(f"{SESSION}: {taken} taken of {CAPACITY} -> filling {need} to leave exactly 1")

for i in range(need):
    st, r = call("POST", "/api/register",
                 payload(f"Filler {WORDS[i % len(WORDS)]}{'x' * (i // len(WORDS))}",
                         f"filler{i}@example.com"),
                 ip=f"172.16.{i // 250}.{i % 250 + 1}")
    if st != 200 or r.get("status") != "confirmed":
        print(f"  filler {i} unexpected: {st} {r}")

taken = confirmed_count(SESSION)
print(f"{SESSION}: {taken} taken of {CAPACITY} (want exactly 1 remaining)\n")
assert CAPACITY - taken == 1, f"setup failed, remaining={CAPACITY - taken}"

# Fire N simultaneous requests at the single remaining spot.
N = 12
results = [None] * N
barrier = threading.Barrier(N)


def contend(i):
    barrier.wait()  # release all threads at the same instant
    results[i] = call("POST", "/api/register",
                      payload(f"Racer {WORDS[i]}", f"racer{i}@example.com"),
                      ip=f"192.0.2.{i + 1}")


threads = [threading.Thread(target=contend, args=(i,)) for i in range(N)]
for t in threads:
    t.start()
for t in threads:
    t.join()

statuses = [r[1].get("status") for r in results if r]
confirmed = statuses.count("confirmed")
waitlist = statuses.count("waitlist")
other = len(statuses) - confirmed - waitlist

print(f"{N} simultaneous requests for 1 remaining spot:")
print(f"  confirmed : {confirmed}")
print(f"  waitlist  : {waitlist}")
print(f"  other     : {other}")

st, av = call("GET", "/api/availability")
sess = next(s for s in av["sessions"] if s["session_time"] == SESSION)
final_taken = confirmed_count(SESSION)
print(f"\nfinal {SESSION}: taken={final_taken}/{CAPACITY} (admin view), full={sess['full']} (public view)")

st, r = call("GET", "/api/admin/registrations", auth="local-dev-admin-token")
rows = r.get("registrations", [])
conf = [x for x in rows if x["session_time"] == SESSION and x["status"] == "confirmed"]

print("\n" + "=" * 58)
ok = True
def chk(label, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  {detail}" if detail and not cond else ""))

chk("exactly 1 request won the last spot", confirmed == 1, f"got {confirmed}")
chk("the other 11 were waitlisted, not lost", waitlist == N - 1, f"got {waitlist}")
chk("no request errored out", other == 0, f"got {other}")
chk("session never oversold past 25", len(conf) == 25, f"db has {len(conf)} confirmed")
chk("public availability reports full", sess["full"] is True)
chk("public availability still hides exact counts",
    not {"taken", "remaining", "capacity"} & set(sess), str(sess))
print("=" * 58)
print("RACE TEST: " + ("PASSED" if ok else "FAILED"))
