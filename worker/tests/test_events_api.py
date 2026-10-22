"""The website's events (the Events plan, phase EV3): src/events/register.js.

Asserted:
- GET /api/events lists open, listed, upcoming events only (never drafts,
  closed, past or unlisted ones), with open/full per session and never a count;
  one event (listed or not) comes with its form and waiver;
- a place (spot): each session holds its own number, then the waiting list;
  no waiting list means "full"; a duplicate, a changed waiver, a closed window,
  another origin and a bot are refused; the form's rules hold (an open gym
  asks less than an evaluation, never less safety);
- interest: recorded with no waiver or medical detail; once per child;
- a team: entered until its division is full, then the waiting list; a
  withdrawn team's place goes to the first waiting team; team names are
  unique per event;
- every sign-up reaches the CRM (a contact, an 'event' activity, the child as
  a player); only an evaluation opens a family card;
- the cancel link withdraws interest and team entries too; a family or staff
  cancelling a place, or a team withdrawing, moves the next one up, and that
  family or coach is told in the event's own words (never the evaluation's);
- staff see interest and teams on the event's page and can confirm, decline
  and withdraw; the daily brief counts sign-ups;
- an event is never a portal program: the portal's list leaves it out.
Emails go only to the local sink (EVENT_EMAILS_ENABLED is on in .dev.vars,
off in wrangler.toml; test_events_unit.mjs and test_events_more.mjs prove
nothing is sent when off).
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, get, make_account, mint_session, post, session_cookies, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"
ORIGIN = "https://tnsaints.com"
W = "evt-waiver-v1"
WSHA = "e" * 64


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def api(method, path, body=None, ip="10.80.0.1", origin=ORIGIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if origin:
        req.add_header("Origin", origin)
    req.add_header("CF-Connecting-IP", ip)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


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


def event(id_, kind, stored, mode, name, sessions, status="open", public=1, waitlist=1, grades=(3, 8), day="2099-06-06",
          closes="2099-06-05T23:59:00.000Z"):
    sql("INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, grade_min, grade_max, "
        "waiver_version_id, public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on, "
        f"location, notify_each_signup) VALUES ('{id_}', '{stored}', '{kind}', '{name}', '{status}', 'approval', 'free', "
        f"{grades[0]}, {grades[1]}, '{W}', {public}, '{closes}', {waitlist}, 'n', 'n', '{mode}', '{day}', "
        "'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069', 1)")
    for name_, start, cap in sessions:
        sql("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, starts_on, capacity, status, created_at, "
            f"updated_at) VALUES ('{id_}', '{name_}', '{name_}', '{start}', '{day}', {cap}, 'active', 'n', 'n')")


def player(name, email, session="6:00 PM", **over):
    p = {"session_time": session, "player_name": name, "grade": "5th", "parent_name": "Pat Parent", "parent_email": email,
         "phone": "(615) 555-0100", "emergency_contact_name": "Erin Contact", "emergency_contact_phone": "(615) 555-0199",
         "medical_notes": "", "assumption_of_risk": True, "medical_release": True, "photo_release": False,
         "signature": "Pat Parent", "waiver_version_id": W, "turnstile_token": "dummy-token"}
    p.update(over)
    return p


# --- setup ------------------------------------------------------------------------------
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
sql("INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
    f"VALUES ('{W}', 'Tennessee Saints Basketball Academy LLC', 'Event waiver', 'WAIVER-TEXT-CANARY', '{WSHA}', 'n', 'n')")
GYM, SCRIM, TOURNEY, EVAL = "2099-06-06-open-gym", "2099-06-06-scrimmage", "2099-06-06-tournament", "2099-06-06-evaluation"
event(GYM, "open_gym", "clinic", "spot", "Open Gym Shoot-Around", [("6:00 PM", "18:00", 2), ("7:00 PM", "19:00", 3)])
event(SCRIM, "scrimmage", "clinic", "interest", "Saturday Scrimmage", [("Game", "18:00", 20)])
event(TOURNEY, "tournament", "tournament", "team", "Saints Classic", [("4th grade", "08:00", 1), ("5th grade", "08:00", 4)])
event(EVAL, "evaluation", "evaluation", "spot", "Spring Evaluation", [("9:00 AM", "09:00", 25)], grades=(3, 6))
event("2099-06-06-camp", "camp", "camp", "spot", "Draft Camp", [("Morning", "09:00", 30)], status="draft")
event("2020-01-04-open-gym", "open_gym", "clinic", "spot", "Old Gym", [("6:00 PM", "18:00", 5)], day="2020-01-04")
event("2099-06-07-open-gym", "open_gym", "clinic", "spot", "Unlisted Gym", [("6:00 PM", "18:00", 5)], public=0, day="2099-06-07")
event("2099-06-08-open-gym", "open_gym", "clinic", "spot", "No-Waitlist Gym", [("6:00 PM", "18:00", 1)], waitlist=0, day="2099-06-08")
sql(f"INSERT OR REPLACE INTO app_settings (key, value, updated_by, updated_at) VALUES ('events.featured', '{GYM}', 'test', 'n')")

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
    print("\n=== the events feed ===")
    st, r = api("GET", "/api/events")
    ids = [e["id"] for e in r.get("events", [])]
    check("open, listed, upcoming events only", st == 200 and set(ids) == {GYM, SCRIM, TOURNEY, EVAL, "2099-06-08-open-gym"}, ids)
    gym = next((e for e in r.get("events", []) if e["id"] == GYM), {})
    check("each with its card, banner and button words", gym.get("kind_label") == "Open gym" and gym.get("cta") == "Sign up"
          and gym.get("date_line") == "Saturday, June 6" and gym.get("featured") is True and r.get("featured") == GYM
          and gym.get("banner", {}).get("title") == "Open Gym Shoot-Around", gym)
    check("open or full per session, and never a count", all(set(s) == {"name", "time", "full"} for s in gym.get("sessions", []))
          and "taken" not in json.dumps(r) and "capacity" not in json.dumps(r))
    check("no forms or waivers in the list", "fields" not in json.dumps(r) and "WAIVER-TEXT-CANARY" not in json.dumps(r))
    st, r = api("GET", f"/api/events/{GYM}")
    names = [f["name"] for f in r.get("event", {}).get("fields", [])]
    check("one event has its form and its waiver", st == 200 and "emergency_contact_name" in names and "signature" in names
          and r["event"]["waiver"]["text"] == "WAIVER-TEXT-CANARY" and r["event"]["waiver"]["id"] == W, names)
    check("an open gym asks less than an evaluation: no player notes, school optional",
          "player_notes" not in names and next(f for f in r["event"]["fields"] if f["name"] == "school")["required"] is False)
    st, r = api("GET", f"/api/events/{EVAL}")
    check("an evaluation asks what it always has", "player_notes" in [f["name"] for f in r["event"]["fields"]]
          and [o["value"] for o in next(f for f in r["event"]["fields"] if f["name"] == "grade")["options"]] == ["3rd", "4th", "5th", "6th"])
    st, r = api("GET", "/api/events/2099-06-07-open-gym")
    check("an unlisted event opens from its link", st == 200 and r["event"]["name"] == "Unlisted Gym", st)
    for gone in ["2099-06-06-camp", "2020-01-04-open-gym", "no-such-event"]:
        st, _ = api("GET", f"/api/events/{gone}")
        check(f"but not a draft, a past event or nothing ({gone})", st == 404, st)
    st, r = api("GET", f"/api/events/{SCRIM}")
    check("interest asks no waiver, no medical, no emergency contact", r["event"]["waiver"] is None
          and not {"medical_notes", "emergency_contact_name", "signature"} & {f["name"] for f in r["event"]["fields"]})

    print("\n=== a place in a session ===")
    res = [api("POST", f"/api/events/{GYM}/register", player(f"Gym Kid{n}", f"gym{i}@example.com"), ip=f"10.81.{i}.1")
           for i, n in enumerate(["Ava", "Ben", "Cal"])]
    check("6:00 PM holds 2, then the waiting list", [x[1].get("status") for x in res] == ["confirmed", "confirmed", "waitlist"],
          [x[1] for x in res])
    check("and says so plainly", "is signed up for Open Gym Shoot-Around" in res[0][1].get("message", "")
          and "waiting list" in res[2][1].get("message", ""))
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidDee", "gym9@example.com", session="7:00 PM"), ip="10.81.9.1")
    check("7:00 PM is its own size", st == 200 and r.get("status") == "confirmed", r)
    st, r = api("GET", "/api/events")
    g = next(e for e in r["events"] if e["id"] == GYM)
    check("the feed now says 6:00 PM is full", [s["full"] for s in g["sessions"]] == [True, False], g["sessions"])
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidAva", "gym0@example.com"), ip="10.81.20.1")
    check("the same child twice is refused", st == 409, (st, r))
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidEve", "gym21@example.com", waiver_version_id="old-v0"), ip="10.81.21.1")
    check("a waiver the form didn't show is refused", st == 409 and r.get("code") == "waiver-changed", (st, r))
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidFay", "gym22@example.com", emergency_contact_name="",
                                                              assumption_of_risk=False), ip="10.81.22.1")
    check("an open gym still needs the emergency contact and the releases", st == 400
          and any("emergency" in e for e in r.get("errors", [])) and any("risk" in e for e in r.get("errors", [])), r)
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidGus", "gym23@example.com"), ip="10.81.23.1", origin="https://evil.example")
    check("another website cannot post", st == 403, st)
    st, r = api("POST", f"/api/events/{GYM}/register", player("Gym KidHal", "gym24@example.com", company="bot"), ip="10.81.24.1")
    check("a bot is refused", st == 400, st)
    st, r = api("POST", "/api/events/2099-06-08-open-gym/register", player("Lone Kid", "lone@example.com"), ip="10.81.25.1")
    st2, r2 = api("POST", "/api/events/2099-06-08-open-gym/register", player("Late Kid", "late@example.com"), ip="10.81.26.1")
    check("with no waiting list, a full session is just full", st == 200 and st2 == 409 and r2.get("code") == "full"
          and sql("SELECT COUNT(*) AS n FROM registrations WHERE event_id = '2099-06-08-open-gym'")[0]["n"] == 1, (st2, r2))
    st, r = api("POST", f"/api/events/{EVAL}/register", player("Eval Kid", "evalkid@example.com", session="9:00 AM",
                                                               school="Franklin Elementary", player_notes="A keen point guard who loves defense."), ip="10.81.27.1")
    check("an evaluation sign-up works as before", st == 200 and r.get("status") == "confirmed", r)
    reg = sql(f"SELECT group_id, waiver_version_id, waiver_sha256, source, player_id FROM registrations WHERE event_id = '{GYM}' "
              "AND player_name = 'Gym KidAva'")
    check("a place records its session by id, the waiver agreed to, and where it came from",
          reg and reg[0]["group_id"] and reg[0]["waiver_version_id"] == W and reg[0]["waiver_sha256"] == WSHA
          and reg[0]["source"] == "website", reg)

    print("\n=== interest ===")
    interest = {"player_name": "Scrim Kid", "grade": "6th", "parent_name": "Sam Parent", "parent_email": "scrim@example.com",
                "phone": "(615) 555-0111", "notes": "Plays forward", "turnstile_token": "dummy-token"}
    st, r = api("POST", f"/api/events/{SCRIM}/register", interest, ip="10.82.0.1")
    check("interest is recorded, no waiver needed", st == 200 and r.get("status") == "interested"
          and sql(f"SELECT status FROM event_interest WHERE event_id = '{SCRIM}'") == [{"status": "interested"}], r)
    st, r = api("POST", f"/api/events/{SCRIM}/register", interest, ip="10.82.0.2")
    check("once per child", st == 409, st)

    print("\n=== teams ===")
    team = {"session_time": "4th grade", "team_name": "Franklin Flyers", "coach_name": "Chris Coach", "coach_email": "flyers@example.com",
            "coach_phone": "(615) 555-0122", "players_count": 9, "agreement": True, "signature": "Chris Coach",
            "waiver_version_id": W, "turnstile_token": "dummy-token"}
    st, r = api("POST", f"/api/events/{TOURNEY}/register", team, ip="10.83.0.1")
    st2, r2 = api("POST", f"/api/events/{TOURNEY}/register", dict(team, team_name="Brentwood Ballers", coach_email="ballers@example.com"),
                  ip="10.83.0.2")
    check("a division takes teams to its size, then the waiting list", r.get("status") == "confirmed" and r2.get("status") == "waitlist",
          (r, r2))
    st, r = api("POST", f"/api/events/{TOURNEY}/register", dict(team, coach_email="other@example.com"), ip="10.83.0.3")
    check("team names are unique in an event", st == 409, st)
    st, r = api("POST", f"/api/events/{TOURNEY}/register", dict(team, team_name="No Agreement", agreement=False), ip="10.83.0.4")
    check("the entry agreement must be signed", st == 400, st)

    print("\n=== the CRM ===")
    time.sleep(1.5)
    c = sql("SELECT kind, source, name FROM crm_contacts WHERE email_norm = 'gym0@example.com'")
    check("a sign-up is a CRM contact, from the event", c == [{"kind": "family", "source": f"event:{GYM}", "name": "Pat Parent"}], c)
    act = sql("SELECT a.detail FROM crm_activities a JOIN crm_contacts c ON c.id = a.contact_id "
              "WHERE c.email_norm = 'gym0@example.com' AND a.kind = 'event'")
    check("with an 'event' activity: ids and kinds only", act and json.loads(act[0]["detail"]).get("event") == GYM
          and "Gym KidAva" not in act[0]["detail"], act)
    check("the child is a player from the start", reg and sql(f"SELECT player_id FROM registrations WHERE event_id = '{GYM}' "
          "AND player_name = 'Gym KidAva'")[0]["player_id"])
    cards = sql("SELECT c.email_norm, o.stage FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id")
    check("only the evaluation opened a family card", cards == [{"email_norm": "evalkid@example.com", "stage": "eval_registered"}], cards)
    coach = sql("SELECT kind, organization FROM crm_contacts WHERE email_norm = 'flyers@example.com'")
    check("a visiting coach is a contact with the team's name", coach == [{"kind": "other", "organization": "Franklin Flyers"}], coach)
    check("interest links the child as a player", sql(f"SELECT player_id FROM event_interest WHERE event_id = '{SCRIM}'")[0]["player_id"])

    print("\n=== withdrawing ===")
    tok = sql(f"SELECT cancel_token FROM event_teams WHERE team_name = 'Franklin Flyers'")[0]["cancel_token"]
    st, r = api("GET", f"/api/cancel/lookup?t={tok}")
    check("the cancel link finds a team entry, and names the event", st == 200 and r.get("player_name") == "Franklin Flyers"
          and r.get("event_label") == "Saints Classic" and r.get("kind") == "team", r)
    st, r = api("POST", "/api/cancel", {"token": tok})
    teams = {x["team_name"]: x["status"] for x in sql(f"SELECT team_name, status FROM event_teams WHERE event_id = '{TOURNEY}'")}
    check("withdrawing frees the division for the waiting team", st == 200
          and teams == {"Franklin Flyers": "withdrawn", "Brentwood Ballers": "entered"}, teams)
    itok = sql(f"SELECT cancel_token FROM event_interest WHERE event_id = '{SCRIM}'")[0]["cancel_token"]
    st, r = api("POST", "/api/cancel", {"token": itok})
    check("and withdraws interest", st == 200 and sql(f"SELECT status FROM event_interest WHERE event_id = '{SCRIM}'")[0]["status"] == "withdrawn")
    gtok = sql(f"SELECT cancel_token FROM registrations WHERE event_id = '{GYM}' AND player_name = 'Gym KidAva'")[0]["cancel_token"]
    st, r = api("POST", "/api/cancel", {"token": gtok})
    check("a family cancelling a place moves the waiting one up", st == 200
          and sql(f"SELECT status FROM registrations WHERE event_id = '{GYM}' AND player_name = 'Gym KidCal'") == [{"status": "confirmed"}])

    print("\n=== the emails (local sink only) ===")
    time.sleep(1)
    to = [m.get("to") for m in _captured]
    check("a family gets a receipt for a place, for interest, and a coach for a team entry",
          ["gym0@example.com"] in to and ["scrim@example.com"] in to and ["flyers@example.com"] in to, len(to))
    moved = [m for m in _captured if m.get("to") == ["gym2@example.com"] and "You're in" in m.get("subject", "")]
    check("the family moved up is told, in the event's words (never the evaluation's)", len(moved) == 1
          and "Open Gym Shoot-Around" in moved[0]["subject"] and "evaluation" not in (moved[0]["subject"] + moved[0].get("text", "")).lower()
          and "6:00 PM session" in moved[0].get("text", ""), [m.get("subject") for m in moved])
    team_up = [m for m in _captured if m.get("to") == ["ballers@example.com"] and "place opened" in m.get("text", "")]
    check("and so is the coach of the team moved up", len(team_up) == 1 and "4th grade division" in team_up[0]["text"],
          [m.get("subject") for m in _captured if m.get("to") == ["ballers@example.com"]])

    print("\n=== staff ===")
    api("POST", f"/api/events/{SCRIM}/register", dict(interest, player_name="Second Kid", parent_email="second@example.com"), ip="10.82.0.3")
    st, _, html = admin("GET", f"/events/{SCRIM}")
    check("the event's page lists who registered interest", st == 200 and "Second Kid" in html and "second@example.com" in html, st)
    iid = sql("SELECT id FROM event_interest WHERE player_name = 'Second Kid'")[0]["id"]
    st, h, _ = admin("POST", f"/events/{SCRIM}/interest/{iid}/confirm")
    check("staff confirm them", "msg=interest-confirmed" in h.get("Location", "")
          and sql(f"SELECT status, decided_by FROM event_interest WHERE id = {iid}") == [{"status": "confirmed", "decided_by": ME}])
    st, _, html = admin("GET", f"/events/{TOURNEY}")
    check("and see the teams", "Brentwood Ballers" in html and "4th grade" in html)
    bid = sql("SELECT id FROM event_teams WHERE team_name = 'Brentwood Ballers'")[0]["id"]
    admin("POST", f"/events/{TOURNEY}/teams/{bid}/withdraw")
    check("and can withdraw one", sql(f"SELECT status FROM event_teams WHERE id = {bid}") == [{"status": "withdrawn"}])
    st, _, html = admin("GET", "/brief")
    check("the daily brief counts the sign-ups", "new event sign-ups in the last day" in html)
    api("POST", f"/api/events/{GYM}/register", player("Gym KidIvy", "gym30@example.com"), ip="10.81.30.1")
    ben = sql(f"SELECT id FROM registrations WHERE event_id = '{GYM}' AND player_name = 'Gym KidBen'")[0]["id"]
    st, _, body = admin("POST", f"/api/registration/{ben}/cancel", cookie=f"tns_admin_event={GYM}")
    check("staff cancelling a place moves the waiting family up", st == 200 and '"promoted":true' in body.replace(" ", "")
          and sql(f"SELECT status FROM registrations WHERE player_name = 'Gym KidIvy'") == [{"status": "confirmed"}], (st, body))
    time.sleep(1)
    ivy = [m for m in _captured if m.get("to") == ["gym30@example.com"] and "You're in" in m.get("subject", "")]
    check("and that family is told, in the event's words", len(ivy) == 1 and "Open Gym Shoot-Around" in ivy[0]["subject"],
          [m.get("subject") for m in _captured if m.get("to") == ["gym30@example.com"]])

    print("\n=== never a portal program ===")
    acct = make_account("portal-parent@example.com")
    S = session_cookies(mint_session(acct))
    post(P + "/family/setup", {"guardian_name": "Portal Parent", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=S)
    st, _, _, html = get(P + "/programs", cookies=S)
    check("the portal's programs page leaves events out", st == 200 and "Open Gym Shoot-Around" not in html and "Saints Classic" not in html, st)
finally:
    _srv.shutdown()

check.finish()
