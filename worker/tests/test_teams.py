"""Teams: rosters, cleared coaches, schedules, the calendar feed.

Asserted: a coach can be put on a team only while their clearances are all
current; a coach sees only their own teams (another team is a 404) and a
roster without medical notes or family contacts; admins schedule practices and
games, validated in Central time; the calendar feed works with its token only,
carries the schedule and never a child, shows cancellations, and stops working
when the link is replaced; families see their child's team schedule and link;
a free place offered by staff is accepted without payment.
"""
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, get, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()
A = "/__admin"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if method == "POST":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace")


def raw_get(path):
    try:
        with urllib.request.urlopen(BASE + path) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, {}, e.read().decode("utf-8", "replace")


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


def loc(h):
    return h.get("location", "").replace(A, "", 1)


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


for t in ["team_events", "team_coaches", "clearances", "paypal_orders", "payments", "enrollments", "consent_records",
          "program_groups", "player_medical", "household_emergency_contacts", "household_members", "sessions",
          "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM programs WHERE id != 'academy'")
sql("DELETE FROM staff")
for email, name, r in ((ME, "Jacob Adams", "admin"), ("cora@example.com", "Cora Coach", "coach"),
                       ("uncleared@example.com", "Una Uncleared", "coach")):
    sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{email}', '{name}', 'Coach', '{r}', 1, datetime('now'), datetime('now'))")

# A free team program with two teams, made through the admin.
admin("POST", "/programs/new", {"name": "Saints Travel", "kind": "team", "billing": "free", "id": "saints-travel"})
admin("POST", "/programs/saints-travel/waivers", {"legal_entity": "Tennessee Saints Basketball Academy LLC",
                                                  "title": "Team waiver", "body_text": "Team text."})
admin("POST", "/programs/saints-travel/settings", {"offer_hold_days": "7", "waiver_version_id": "saints-travel-v1"})
admin("POST", "/programs/saints-travel/groups", {"name": "U12 Black", "schedule_summary": "Tue/Thu 6 PM", "capacity": "12"})
admin("POST", "/programs/saints-travel/groups", {"name": "U12 Gold", "schedule_summary": "Mon/Wed 6 PM", "capacity": "12"})
admin("POST", "/programs/saints-travel/status", {"status": "open"})
BLACK = one("SELECT id FROM program_groups WHERE name='U12 Black'")["id"]
GOLD = one("SELECT id FROM program_groups WHERE name='U12 Gold'")["id"]
check("a team program with two teams exists", one("SELECT status, enrollment_mode FROM programs WHERE id='saints-travel'")
      == {"status": "open", "enrollment_mode": "approval"})

# A family applies; staff offer a place on U12 Black; the family accepts (free: no payment).
S = session_cookies(mint_session(make_account("team-fam@example.com")))
post(P + "/family/setup", {"guardian_name": "Tia Team", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=S)
post(P + "/contacts", {"ec1_name": "Grandpa", "ec1_phone": "(615) 555-0111"}, cookies=S)
post(P + "/children", {"child_name": "Tom Teamer", "date_of_birth": "2015-04-04", "grade": "5", "school": "Team School",
                       "shirt_size": "YL"}, cookies=S)
TOM = one("SELECT id FROM players WHERE display_name='Tom Teamer'")["id"]
post(P + f"/children/{TOM}/medical", {"medical_status": "declared", "medical_notes": "TEAM-MEDICAL-CANARY"}, cookies=S)
post(P + f"/children/{TOM}/apply/saints-travel", {"waiver_version": "saints-travel-v1", "agree_risk": "on", "agree_medical": "on", "agree_esign": "on",
                                                  "photo_release": "yes", "signature": "Tia Team", "relationship": "Mother"}, cookies=S)
E = one(f"SELECT id, ref FROM enrollments WHERE player_id={TOM}")
admin("POST", f"/enrollments/{E['id']}/offer", {"group_id": str(BLACK)})
st, _, _, html = get(P + f"/pay/{E['ref']}", cookies=S)
check("a free place offered by staff is accepted with a button, no payment", st == 200 and f"/pay/{E['ref']}/accept" in html
      and "paypal" not in html.lower(), st)
st, h, _, _ = post(P + f"/pay/{E['ref']}/accept", {}, cookies=S)
check("accepting confirms it", "notice=registered" in h.get("Location", "")
      and one(f"SELECT status FROM enrollments WHERE id={E['id']}")["status"] == "active", h.get("Location"))

print("\n=== coaches must be cleared ===")
st, h, _ = admin("POST", f"/teams/{BLACK}/coaches", {"email": "uncleared@example.com", "role": "head"})
check("a coach without current clearances is not assigned", "msg=not-cleared" in loc(h)
      and one("SELECT COUNT(*) AS n FROM team_coaches")["n"] == 0, loc(h))
for kind in ("background_check", "abuse_prevention", "concussion_training"):
    admin("POST", "/clearances", {"person_email": "cora@example.com", "person_name": "Cora Coach", "kind": kind,
                                  "completed_on": "2026-01-01", "expires_on": "2030-01-01"})
st, h, _ = admin("POST", f"/teams/{BLACK}/coaches", {"email": "cora@example.com", "role": "head"})
check("once cleared, she is assigned", "msg=assigned" in loc(h), loc(h))
st, h, _ = admin("POST", f"/teams/{BLACK}/coaches", {"email": "nobody@example.com", "role": "head"})
check("someone not on staff is refused", "msg=not-staff" in loc(h), loc(h))
st, h, _ = admin("POST", f"/teams/{BLACK}/coaches", {"email": "cora@example.com", "role": "assistant"})
check("and nobody is assigned twice", "msg=exists" in loc(h), loc(h))

print("\n=== the schedule ===")
st, _, html = admin("POST", f"/teams/{BLACK}/events", {"kind": "game", "starts_at": "2026-13-40T99:00"})
check("an impossible time is refused, with the reason", st == 400 and "Enter when it starts." in html, st)
st, _, html = admin("POST", f"/teams/{BLACK}/events", {"kind": "game", "starts_at": "2099-03-07T10:00", "ends_at": "2099-03-07T09:00"})
check("ending before it starts is refused", st == 400 and "end after it starts" in html, st)
st, h, _ = admin("POST", f"/teams/{BLACK}/events", {"kind": "game", "starts_at": "2099-03-07T10:00", "ends_at": "2099-03-07T11:30",
                                                    "location": "Franklin Rec, Court 2", "opponent": "Nashville Hawks",
                                                    "notes": "Wear black; arrive 30 minutes early"})
check("a game is scheduled", "msg=event-added" in loc(h), loc(h))
ev = one(f"SELECT id, starts_at FROM team_events WHERE group_id={BLACK}")
check("its time is stored as the instant it means (10 AM Central in March = 16:00 UTC)", ev["starts_at"] == "2099-03-07T16:00:00.000Z", ev)
admin("POST", f"/teams/{BLACK}/events", {"kind": "practice", "starts_at": "2099-03-05T18:00"})
PRACTICE = one(f"SELECT id FROM team_events WHERE kind='practice'")["id"]
st, h, _ = admin("POST", f"/teams/{BLACK}/events/{PRACTICE}/cancel")
check("a practice is cancelled", "msg=event-cancelled" in loc(h), loc(h))

print("\n=== the calendar feed ===")
st, _, html = admin("GET", f"/teams/{BLACK}")
m = re.search(r"/calendar/(\d+)/([A-Za-z0-9_-]{32})\.ics", html)
check("the team page shows its calendar link", st == 200 and m, st)
FEED = f"{P}/calendar/{m.group(1)}/{m.group(2)}.ics"
st, h, ics = raw_get(FEED)
check("the feed is a calendar", st == 200 and h.get("content-type", "").startswith("text/calendar") and "BEGIN:VCALENDAR" in ics, st)
check("with the game, its place (escaped) and time", "SUMMARY:U12 Black: Game vs Nashville Hawks" in ics
      and "LOCATION:Franklin Rec\\, Court 2" in ics and "DTSTART:20990307T160000Z" in ics)
check("and the cancelled practice marked cancelled", "STATUS:CANCELLED" in ics)
check("and never a child", "Tom" not in ics and "Teamer" not in ics and "CANARY" not in ics)
st, _, _ = raw_get(f"{P}/calendar/{m.group(1)}/{'x' * 32}.ics")
check("a wrong token is a 404", st == 404, st)
st, _, _ = raw_get(f"{P}/calendar/{GOLD}/{m.group(2)}.ics")
check("one team's token does not open another's feed", st == 404, st)
st, h, _ = admin("POST", f"/teams/{BLACK}/calendar/rotate")
st, _, _ = raw_get(FEED)
check("replacing the link turns the old one off", "msg=rotated" in loc(h) and st == 404, st)

print("\n=== what a coach sees ===")
role("coach")
sql(f"UPDATE staff SET role='admin' WHERE email_norm='cora@example.com'")  # keep an admin around
sql(f"INSERT INTO team_coaches (group_id, staff_email, role, assigned_by, assigned_at) VALUES ({BLACK}, '{ME}', 'assistant', 'test', 'n')")
st, _, html = admin("GET", "/teams")
check("a coach sees the teams they coach, and only those", st == 200 and "U12 Black" in html and "U12 Gold" not in html, st)
st, _, html = admin("GET", f"/teams/{BLACK}")
check("their roster: the child, grade and a medical flag", st == 200 and "Tom Teamer" in html and "Medical note" in html, st)
check("but not the note, and not the family", "TEAM-MEDICAL-CANARY" not in html and "/crm/families/" not in html)
check("and no controls to change the team", "/coaches" not in html and "Add to the schedule" not in html)
st, _, _ = admin("GET", f"/teams/{GOLD}")
check("another team's page is a 404", st == 404, st)
st, _, _ = admin("POST", f"/teams/{BLACK}/events", {"kind": "game", "starts_at": "2099-03-09T10:00"})
check("a coach cannot change the schedule", st == 403, st)
role("admin")

print("\n=== families ===")
st, _, _, html = get(P + "/", cookies=S)
check("the family page shows the team's next events and the calendar link", "Team schedule" in html and "U12 Black" in html
      and "vs Nashville Hawks" in html and "/calendar/" in html, html[-300:] if st == 200 else st)

check.finish()
