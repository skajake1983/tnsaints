"""Events, past and present (the Events plan, phase EV1).

Asserted:
- the Events page lists every evaluation, past and upcoming (8/29 is a past
  event, migration 022), and shows one event's sessions, each with its own
  size; coaches cannot open it;
- a session holds its own number, not the smallest session's;
- the family's confirmation email says the event's date, place and grades,
  not 8/29's;
- staff can look back at any event's roster, evaluations and decisions without
  changing the current evaluation (a cookie the picker sets; only an event
  they can already see; only back to an admin page), and are told when they
  are not on the current one;
- an event's sign-ups download as a CSV with no cancel tokens and no medical
  text, audited with counts only;
- a cancel link from an earlier event still works, for that event, after the
  current evaluation changes;
- sign-ups wait for an event's opening time.

Creating and running events (EV2):
- a new event starts from the last of its kind (8/29's place and sessions,
  without its date in the name); mistakes come back with the form as typed
  and nothing is created; a valid one is a hidden draft with its sessions,
  closing the day before at 11:59 PM Central;
- publishing needs a waiver; publishing opens and lists it; the preview shows
  the website card, and the banner once it is featured;
- repeat weekly makes the next open gyms, a week apart, in one series;
- a priced camp is paid at check-in (online payment waits for Stripe);
- archived events leave the lists; coaches cannot create events.
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import WORKER_DIR, execute_local
from _harness import preflight, staff_email
from _portal import BASE, Checker, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"
ORIGIN = "https://tnsaints.com"
OLD = "2026-08-29-evaluation"
NEW = "2027-03-06-evaluation"
TOK = {"ada": "a" * 64, "ben": "b" * 64, "cal": "c" * 64}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None, cookie=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def api(method, path, body=None, ip="10.70.0.1"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Origin", ORIGIN)
    req.add_header("CF-Connecting-IP", ip)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def payload(name, email, session):
    return {"session_time": session, "player_name": name, "grade": "5th", "years_experience": 2,
            "parent_name": "Parent " + name.split()[-1], "parent_email": email, "phone": "(615) 555-0100",
            "school": "Franklin Elementary", "emergency_contact_name": "Emergency Contact",
            "emergency_contact_phone": "(615) 555-0199", "player_notes": "Automated events test registration entry.",
            "medical_notes": "", "assumption_of_risk": True, "medical_release": True, "photo_release": True,
            "signature": "Parent Guardian", "turnstile_token": "dummy-token"}


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


def reg(token, name, session, status="confirmed", event=OLD, medical="NULL"):
    sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, "
        "parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, "
        "medical_notes, assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at) VALUES "
        f"('{event}', '{session}', '{status}', '{token}', '{name}', '{name.lower()}', '5th', 'P', 'p-{token[:4]}@example.com', "
        f"'p-{token[:4]}@example.com', '615', 'S', 'EC', '615', {medical}, 1, 1, 1, 'Sig', "
        "strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))")


# --- setup ----------------------------------------------------------------------------
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
for t in ["app_settings"]:
    sql(f"DELETE FROM {t} WHERE key = 'evaluation.current'")
execute_local(file=os.path.join(WORKER_DIR, "migrations", "022_events_past_evaluation.sql"))
reg(TOK["ada"], "Ada Past", "9:00 AM", medical="'PAST-MEDICAL-CANARY'")
reg(TOK["ben"], "Ben Past", "10:00 AM")
reg(TOK["cal"], "Cal Waiting", "9:00 AM", status="waitlist")
sql("INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
    f"VALUES ('ev-test-w', 'Saints LLC', 'Evaluation waiver', 'text', '{'d' * 64}', 'n', 'n')")
sql("INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, grade_min, grade_max, waiver_version_id, public, "
    f"registration_closes_at, created_at, updated_at) VALUES ('{NEW}', 'evaluation', 'Spring Evaluation - March 6, 2027', "
    "'open', 'approval', 'free', 3, 6, 'ev-test-w', 0, '2099-01-01T00:00:00.000Z', 'n', 'n')")
for name, start, cap in [("9:00 AM", "09:00", 2), ("10:00 AM", "10:00", 5)]:
    sql("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, location, starts_on, capacity, status, "
        f"created_at, updated_at) VALUES ('{NEW}', '{name}', '{name}', '{start}', 'Spring Gym, 1 Main St, Franklin, TN', "
        f"'2027-03-06', {cap}, 'active', 'n', 'n')")
sql(f"INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('evaluation.current', '{NEW}', 'test', 'n')")

_captured = []


class _Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        _captured.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        body = b'{"id":"sink"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_srv = ThreadingHTTPServer(("127.0.0.1", 8799), _Sink)
threading.Thread(target=_srv.serve_forever, daemon=True).start()

try:
    print("\n=== the Events page ===")
    st, _, html = admin("GET", "/events")
    open_part = html.split("Open for sign-ups", 1)[-1].split("Coming up", 1)[0]
    past_part = html.split("<h2>Past", 1)[-1]
    check("it lists the open evaluation, and 8/29 as a past one", st == 200 and "Spring Evaluation - March 6, 2027" in open_part
          and "Free Academy Evaluation - Saturday, August 29, 2026" in past_part, st)
    check("with how many signed up and waiting", "2 · 1 waiting" in past_part)
    st, _, html = admin("GET", f"/events/{NEW}")
    check("one event's page shows each session at its own size", st == 200 and "0 of 2" in html and "0 of 5" in html
          and "the current evaluation" in html, st)
    st, _, _ = admin("GET", "/events/no-such-event")
    check("an event that doesn't exist is a 404", st == 404, st)
    role("coach")
    st, _, _ = admin("GET", "/events")
    check("a coach cannot open Events", st == 403, st)
    role("admin")

    print("\n=== each session holds its own number ===")
    early = [api("POST", "/api/register", payload(f"Early {n}", f"early{i}@example.com", "9:00 AM"), ip=f"10.71.{i}.1")
             for i, n in enumerate(["Avery", "Blake", "Casey"])]
    check("9:00 AM holds 2, then the waiting list", [r[1].get("status") for r in early] == ["confirmed", "confirmed", "waitlist"],
          [r[1] for r in early])
    late = [api("POST", "/api/register", payload(f"Late {n}", f"late{i}@example.com", "10:00 AM"), ip=f"10.72.{i}.1")
            for i, n in enumerate(["Drew", "Emery", "Finley"])]
    check("while 10:00 AM, which holds 5, takes all three", [r[1].get("status") for r in late] == ["confirmed"] * 3,
          [r[1] for r in late])
    st, av = api("GET", "/api/availability")
    full = {s["session_time"]: s["full"] for s in av.get("sessions", [])}
    check("availability says so", full == {"9:00 AM": True, "10:00 AM": False}, av)

    print("\n=== the family's email is worded from the event ===")
    time.sleep(1.5)
    mine = [m for m in _captured if "early0@example.com" in (m.get("to") or [])]
    body = (mine[0].get("html", "") + mine[0].get("text", "")) if mine else ""
    check("it gives the event's date, place and grades", "Saturday, March 6" in body and "Spring Gym, 1 Main St, Franklin, TN" in body
          and "open to 3rd–6th grade" in body, len(mine))
    check("and nothing of 8/29's", mine and "August 29" not in body and "flyer" not in body and "8/27" not in body)

    print("\n=== staff can look back at any event ===")
    st, _, html = admin("GET", "/")
    check("Roster shows the current evaluation, with a picker that offers 8/29", "Spring Evaluation - March 6, 2027</h1>" in html
          and f'<option value="{OLD}"' in html and "Early Avery" in html)
    st, h, _ = admin("POST", "/events/view", {"event": OLD, "return": "/"})
    sc = h.get("Set-Cookie", "")
    check("choosing 8/29 remembers it for this browser, and goes back to Roster",
          st == 303 and h.get("Location", "") == A + "/" and f"tns_admin_event={OLD}" in sc and "HttpOnly" in sc
          and "Secure" in sc and "SameSite=Strict" in sc, (st, h.get("Location"), sc))
    COOKIE = f"tns_admin_event={OLD}"
    st, _, html = admin("GET", "/", cookie=COOKIE)
    check("Roster then shows 8/29's players, each session at 25", "Free Academy Evaluation - Saturday, August 29, 2026</h1>" in html
          and "Ada Past" in html and "Ben Past" in html and "Early Avery" not in html and "1 of 25" in html)
    check("and says it isn't the current evaluation", "not the current" in html and "Back to the current evaluation" in html)
    st, _, html = admin("GET", "/eval", cookie=COOKIE)
    check("so do Evaluations", st == 200 and "not the current" in html and f'<option value="{OLD}" selected' in html)
    st, _, html = admin("GET", "/decisions", cookie=COOKIE)
    check("and Decisions", st == 200 and "not the current" in html)
    st, _, html = admin("GET", "/api/roster", cookie=COOKIE)
    names = {r["player_name"] for r in json.loads(html).get("registrations", [])} if st == 200 else set()
    check("the roster's JSON follows the same choice", names == {"Ada Past", "Ben Past", "Cal Waiting"}, names)
    st, h, _ = admin("POST", "/events/view", {"event": "x'; DROP", "return": "https://evil.example/"})
    check("anything but a real event clears the choice, and only an admin page is a place to return to",
          st == 303 and h.get("Location") == A + "/" and "Max-Age=0" in h.get("Set-Cookie", ""), (st, h))
    st, _, html = admin("GET", "/", cookie="tns_admin_event=gone-event")
    check("a cookie for an event that is gone shows the current one", "Spring Evaluation - March 6, 2027</h1>" in html)
    role("coach")
    st, h, _ = admin("POST", "/events/view", {"event": OLD, "return": "/eval"})
    check("a coach can choose too (they read rosters)", st == 303 and h.get("Location") == A + "/eval", st)
    role("admin")

    print("\n=== an event's sign-ups, as a CSV ===")
    st, h, csv = admin("GET", f"/events/{OLD}/registrations.csv")
    header = csv.splitlines()[0] if csv else ""
    check("it downloads, one row per sign-up", st == 200 and h.get("Content-Type", "").startswith("text/csv")
          and len(csv.strip().splitlines()) == 4, (st, len(csv.splitlines())))
    check("with a medical flag and no medical text, and no cancel tokens", "has_medical_notes" in header
          and "PAST-MEDICAL-CANARY" not in csv and "cancel_token" not in header and TOK["ada"] not in csv, header)
    a = sql(f"SELECT detail FROM audit_log WHERE action = 'roster.export' AND subject_id = '{OLD}' ORDER BY id DESC LIMIT 1")
    check("audited with the count, and no names", a and json.loads(a[0]["detail"]).get("count") == 3 and "Ada" not in a[0]["detail"], a)
    role("coach")
    st, _, _ = admin("GET", f"/events/{OLD}/registrations.csv")
    check("a coach cannot export", st == 403, st)
    role("admin")

    print("\n=== a cancel link from 8/29 still works, for 8/29 ===")
    st, r = api("GET", f"/api/cancel/lookup?t={TOK['ada']}")
    check("it finds the registration and names its event", st == 200 and r.get("player_name") == "Ada Past"
          and r.get("event_label") == "Free Academy Evaluation - Saturday, August 29, 2026", r)
    st, r = api("POST", "/api/cancel", {"token": TOK["ada"], "reason": "Moved away"})
    s = {x["player_name"]: x["status"] for x in sql(f"SELECT player_name, status FROM registrations WHERE event_id = '{OLD}'")}
    check("cancelling frees the seat in 8/29's session, and 8/29's waiting family moves up",
          st == 200 and s.get("Ada Past") == "cancelled" and s.get("Cal Waiting") == "confirmed", (st, s))
    s2 = {x["player_name"]: x["status"] for x in sql(f"SELECT player_name, status FROM registrations WHERE event_id = '{NEW}'")}
    check("the current event's waiting list is untouched", s2.get("Early Casey") == "waitlist", s2)

    print("\n=== sign-ups wait for an event's opening time ===")
    sql(f"UPDATE programs SET registration_opens_at = '2099-01-01T00:00:00.000Z', registration_closes_at = '2099-02-01T00:00:00.000Z' "
        f"WHERE id = '{NEW}'")
    st, r = api("POST", "/api/register", payload("Too Soon", "soon@example.com", "10:00 AM"), ip="10.73.0.1")
    st2, av = api("GET", "/api/availability")
    check("not before it opens", st == 403 and av.get("registration_open") is False, (st, r, av.get("registration_open")))
finally:
    _srv.shutdown()
    sql("DELETE FROM app_settings WHERE key = 'evaluation.current'")


print("\n=== creating an event: it starts from the last of its kind ===")
sql(f"UPDATE programs SET registration_opens_at = NULL, registration_closes_at = '2099-01-01T00:00:00.000Z' WHERE id = '{NEW}'")
st, _, html = admin("GET", "/events/new")
check("the New event page offers the five kinds", st == 200 and all(f'value="{k}"' in html for k in
      ["evaluation", "open_gym", "camp", "scrimmage", "tournament"]), st)
st, _, html = admin("GET", "/events/new/form?kind=evaluation&from=" + OLD)
check("copied from 8/29: its sessions and place, its name without the old date, and no date",
      st == 200 and 'name="name" value="Free Academy Evaluation"' in html and 'value="9:00 AM"' in html
      and 'value="10:00 AM"' in html and "2316 Hillsboro Rd" in html and 'name="starts_on" value=""' in html, st)
st, _, html = admin("GET", "/events/new/form?kind=evaluation&from=last")
check("'the last of this kind' is the latest one (the spring evaluation)", 'name="name" value="Spring Evaluation' in html)
FORM = {"kind": "evaluation", "name": "Fall Evaluation", "starts_on": "2026-12-05",
        "location": "Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069", "grade_min": "3", "grade_max": "6",
        "s1_name": "9:00 AM", "s1_start": "09:00", "s1_end": "10:00", "s1_cap": "25",
        "s2_name": "10:00 AM", "s2_start": "10:00", "s2_end": "11:00", "s2_cap": "20", "notify": "1", "waitlist": "1",
        "description": "A free look at every player, 3rd to 6th grade."}
bad = dict(FORM, starts_on="", s2_cap="0", grade_min="6", grade_max="3")
st, _, html = admin("POST", "/events/new", bad)
check("mistakes come back named, with what was typed, and nothing is created",
      st == 400 and "Choose the day it happens" in html and "Session 2" in html and "youngest first" in html
      and 'value="Fall Evaluation"' in html and sql("SELECT 1 FROM programs WHERE name = 'Fall Evaluation'") == [], st)
st, h, _ = admin("POST", "/events/new", FORM)
FALL = "2026-12-05-evaluation"
row = sql(f"SELECT status, public, signup_mode, starts_on, location, registration_closes_at, notify_each_signup, billing "
          f"FROM programs WHERE id = '{FALL}'")
check("a valid one is saved as a hidden draft, named by its date and kind", st == 303 and FALL in h.get("Location", "")
      and row and row[0]["status"] == "draft" and row[0]["public"] == 0 and row[0]["signup_mode"] == "spot"
      and row[0]["billing"] == "free", (st, row))
check("sign-ups close at 11:59 PM Central the day before", row and row[0]["registration_closes_at"] == "2026-12-05T05:59:00.000Z", row)
g = sql(f"SELECT name, capacity, starts_on, start_time FROM program_groups WHERE program_id = '{FALL}' ORDER BY start_time")
check("with its sessions, each its own size, on its day", [(x["name"], x["capacity"], x["starts_on"]) for x in g]
      == [("9:00 AM", 25, "2026-12-05"), ("10:00 AM", 20, "2026-12-05")], g)
st, h, _ = admin("POST", "/events/new", FORM)
check("another on the same day gets its own id", h.get("Location", "").endswith(f"/events/{FALL}-2?msg=created"), h.get("Location"))
sql(f"UPDATE programs SET status = 'archived' WHERE id = '{FALL}-2'")

print("\n=== publishing ===")
st, h, _ = admin("POST", f"/events/{FALL}/publish")
check("not without a waiver", "msg=needs-waiver" in h.get("Location", "")
      and sql(f"SELECT status FROM programs WHERE id = '{FALL}'")[0]["status"] == "draft", h.get("Location"))
sql(f"UPDATE programs SET waiver_version_id = 'ev-test-w' WHERE id = '{FALL}'")
st, h, _ = admin("POST", f"/events/{FALL}/publish")
r = sql(f"SELECT status, public, published_at FROM programs WHERE id = '{FALL}'")[0]
check("then it opens and is listed", "msg=published" in h.get("Location", "") and r["status"] == "open" and r["public"] == 1
      and r["published_at"], r)
st, _, html = admin("GET", f"/events/{FALL}")
check("its page previews the website card", st == 200 and 'class="pv-card"' in html and "Saturday, December 5 · 9:00–11:00 AM" in html
      and "3rd–6th grade · Free" in html and "Sign up by Dec 4" in html and 'class="pv-banner"' not in html)
st, h, _ = admin("POST", f"/events/{FALL}/feature")
st, _, html = admin("GET", f"/events/{FALL}")
check("featured, the banner shows too", 'class="pv-banner"' in html and "Take out of the banner" in html
      and sql("SELECT value FROM app_settings WHERE key = 'events.featured'") == [{"value": FALL}])
admin("POST", f"/events/{FALL}/unfeature")
check("and can be taken out", sql("SELECT 1 FROM app_settings WHERE key = 'events.featured'") == [])
st, h, _ = admin("POST", f"/events/{FALL}/close")
check("closing stops sign-ups", sql(f"SELECT status FROM programs WHERE id = '{FALL}'")[0]["status"] == "closed")
check("each step is audited", {"event.created", "event.published", "event.featured", "event.closed"}
      <= {x["action"] for x in sql("SELECT action FROM audit_log WHERE action LIKE 'event.%'")})

print("\n=== open gyms, weekly ===")
GYM = {"kind": "open_gym", "name": "Open Gym Shoot-Around", "starts_on": "2026-11-03", "location": "Grassland Heights gym, Franklin, TN",
       "grade_min": "3", "grade_max": "8", "s1_name": "6:00 PM", "s1_start": "18:00", "s1_end": "19:30", "s1_cap": "20"}
admin("POST", "/events/new", GYM)
st, h, _ = admin("POST", "/events/2026-11-03-open-gym/repeat", {"weeks": "3"})
gyms = sql("SELECT id, starts_on, series_id, registration_closes_at FROM programs WHERE event_kind = 'open_gym' ORDER BY starts_on")
check("repeat weekly makes the next three, a week apart, in one series", "msg=repeated" in h.get("Location", "")
      and [x["starts_on"] for x in gyms] == ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"]
      and len({x["series_id"] for x in gyms}) == 1, gyms)
check("each one's sign-up close moves with it", [x["registration_closes_at"][:10] for x in gyms]
      == ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"], gyms)
summ = sql("SELECT schedule_summary FROM program_groups WHERE program_id = '2026-11-17-open-gym'")
check("and its session names its own day", summ and summ[0]["schedule_summary"].startswith("Tuesday, November 17"), summ)
st, h, _ = admin("POST", "/events/2026-11-03-open-gym/repeat", {"weeks": "13"})
check("but not more than 12 weeks at once", "msg=invalid" in h.get("Location", ""))

print("\n=== a priced camp, and a tournament ===")
st, _, html = admin("GET", "/events/new/form?kind=camp&from=")
check("the first camp's description starts with the owner's refund policy",
      "cancel at least 7 days before the camp for a full refund" in html.replace("&#39;", "'"), st)
CAMP = {"kind": "camp", "name": "Winter Camp", "starts_on": "2026-12-28", "ends_on": "2026-12-30", "location": "Franklin, TN",
        "s1_name": "Morning", "s1_start": "09:00", "s1_end": "12:00", "s1_cap": "30", "price": "75"}
admin("POST", "/events/new", CAMP)
camp = sql("SELECT billing, price_cents, payment_policy, ends_on FROM programs WHERE id = '2026-12-28-camp'")
check("a priced camp is paid at check-in for now", camp == [{"billing": "one_time", "price_cents": 7500,
      "payment_policy": "at_check_in", "ends_on": "2026-12-30"}], camp)
st, _, html = admin("GET", "/events/2026-12-28-camp")
check("and says so", "$75, paid at check-in" in html and "Monday, December 28 – Wednesday, December 30" in html)
st, _, html = admin("GET", "/events/new/form?kind=tournament&from=")
check("a tournament asks who signs up: teams by default", 'value="team" checked' in html and 'value="interest"' in html)
admin("POST", "/events/new", {"kind": "tournament", "mode": "interest", "name": "Spring Tournament", "starts_on": "2027-04-17",
                              "location": "Nashville, TN", "s1_name": "5th grade", "s1_cap": "10"})
check("and keeps the choice", sql("SELECT signup_mode FROM programs WHERE id = '2027-04-17-tournament'") == [{"signup_mode": "interest"}])

print("\n=== archive, and who may ===")
admin("POST", "/events/2026-12-28-camp/archive")
st, _, html = admin("GET", "/events")
check("an archived event leaves the list", "Winter Camp" not in html and "Open Gym Shoot-Around" in html)
role("coach")
st, _, _ = admin("GET", "/events/new")
st2, _, _ = admin("POST", "/events/new", GYM)
check("a coach cannot create events", st == 403 and st2 == 403, (st, st2))
role("admin")

check.finish()
