"""Program settings in the admin: price, groups, waiver versions, open/close.

The owner enters the academy's price (O5), groups (O8) and waiver (O9) here.
Asserted: bad input changes nothing; a waiver version is hashed exactly and is
never editable; the program cannot open until price, PayPal plan and waiver
exist, and an open program cannot lose them; only admins get in.
"""
import hashlib
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, Checker, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None, headers=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + A + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


def msg(h):
    return urllib.parse.parse_qs(urllib.parse.urlparse(h.get("Location", "")).query).get("msg", [None])[0]


def academy():
    return sql("SELECT status, price_cents, setup_fee_cents, offer_hold_days, grade_min, grade_max, "
               "paypal_plan_id_sandbox, waiver_version_id FROM programs WHERE id='academy'")[0]


SETTINGS = {"price": "150.00", "setup_fee": "40.00", "offer_hold_days": "7", "grade_min": "3", "grade_max": "6",
            "paypal_plan_id_live": "P-3A8355760P817903NNKZ4ZGQ", "paypal_plan_id_sandbox": "P-SANDBOXTEST123456",
            "waiver_version_id": ""}
BODY = "Participation waiver (test)\r\n\r\nI understand basketball involves risk.\r\nI authorise emergency care."

for t in ["enrollments", "consent_records", "program_groups"]:
    sql(f"DELETE FROM {t}")
sql("UPDATE programs SET status='draft', price_cents=NULL, waiver_version_id=NULL, paypal_plan_id_sandbox=NULL WHERE id='academy'")
sql("DELETE FROM waiver_versions")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

print("\n=== the settings page ===")
st, _, html = admin("GET", "/programs/academy")
check("it opens for an admin", st == 200 and "Tennessee Saints Academy" in html, st)
check("it says the academy is a draft and lists what is missing",
      "Draft" in html and "A monthly price" in html and "A waiver for families to sign" in html)
check("the open button is disabled while anything is missing", "disabled>Open to families" in html)
st, _, html = admin("GET", "/enrollments")
check("the enrollment queue links to it", "/programs/academy" in html)

print("\n=== price and settings ===")
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "price": "one fifty"})
check("a price that is not money is refused, and nothing changes", msg(h) == "invalid" and academy()["price_cents"] is None, msg(h))
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "grade_min": "6", "grade_max": "3"})
check("an inverted grade range is refused", msg(h) == "invalid")
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "paypal_plan_id_sandbox": "not-a-plan"})
check("a malformed PayPal plan id is refused", msg(h) == "invalid")
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "waiver_version_id": "no-such-waiver"})
check("a waiver that does not exist is refused", msg(h) == "invalid")
st, h, _ = admin("POST", "/programs/academy/settings", SETTINGS)
a = academy()
check("valid settings save, money in exact cents", msg(h) == "saved" and a["price_cents"] == 15000
      and a["setup_fee_cents"] == 4000 and a["grade_min"] == 3 and a["paypal_plan_id_sandbox"] == "P-SANDBOXTEST123456", a)
st, h, _ = admin("POST", "/programs/academy/status", {"status": "open"})
check("it still cannot open without a waiver", msg(h) == "cannot-open" and academy()["status"] == "draft", msg(h))

print("\n=== waiver versions ===")
st, h, _ = admin("POST", "/programs/academy/waivers", {"legal_entity": "", "title": "t", "body_text": BODY})
check("a waiver needs the legal name of who families agree with", msg(h) == "invalid")
st, h, _ = admin("POST", "/programs/academy/waivers",
                 {"legal_entity": "Tennessee Saints Basketball Academy LLC", "title": "Participation waiver", "body_text": BODY})
w = sql("SELECT id, body_text, body_sha256, legal_entity FROM waiver_versions")
expected = BODY.replace("\r\n", "\n").strip()
check("a waiver version is saved as academy-v1", msg(h) == "waiver-saved" and w and w[0]["id"] == "academy-v1", (msg(h), w))
check("its line breaks are kept as written", w and w[0]["body_text"] == expected)
check("and its hash is exactly SHA-256 of that text",
      w and w[0]["body_sha256"] == hashlib.sha256(expected.encode()).hexdigest())
admin("POST", "/programs/academy/waivers", {"legal_entity": "Tennessee Saints Inc. (non-profit)", "title": "Waiver v2", "body_text": BODY + " More."})
check("the next version is academy-v2", sql("SELECT id FROM waiver_versions ORDER BY id") == [{"id": "academy-v1"}, {"id": "academy-v2"}])
st, _, _ = admin("POST", "/programs/academy/waivers/academy-v1", {"body_text": "rewritten"})
check("there is no way to edit a saved version", sql("SELECT body_text FROM waiver_versions WHERE id='academy-v1'")[0]["body_text"] == expected)

print("\n=== opening ===")
admin("POST", "/programs/academy/settings", {**SETTINGS, "waiver_version_id": "academy-v1"})
st, h, _ = admin("POST", "/programs/academy/status", {"status": "open"})
check("with price, plan and waiver it opens", msg(h) == "opened" and academy()["status"] == "open", msg(h))
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "price": "", "waiver_version_id": "academy-v1"})
check("an open program cannot lose its price", msg(h) == "invalid" and academy()["price_cents"] == 15000, msg(h))
st, h, _ = admin("POST", "/programs/academy/settings", {**SETTINGS, "waiver_version_id": ""})
check("or its waiver", msg(h) == "invalid" and academy()["waiver_version_id"] == "academy-v1")
st, h, _ = admin("POST", "/programs/academy/status", {"status": "archived"})
check("only open and closed are accepted as a status change", msg(h) == "invalid" and academy()["status"] == "open")

print("\n=== groups ===")
GROUP = {"name": "Tuesday 3rd-4th", "schedule_summary": "Tuesdays 6:00-7:30 PM", "weekday": "2", "start_time": "18:00",
         "end_time": "19:30", "location": "Grassland Heights gym", "starts_on": "2026-10-06", "capacity": "10",
         "grade_min": "3", "grade_max": "4"}
st, h, _ = admin("POST", "/programs/academy/groups", {**GROUP, "capacity": "0"})
check("a group needs at least one seat", msg(h) == "invalid" and sql("SELECT 1 FROM program_groups") == [])
st, h, _ = admin("POST", "/programs/academy/groups", {**GROUP, "start_time": "6pm"})
check("times must be real times", msg(h) == "invalid")
st, h, _ = admin("POST", "/programs/academy/groups", GROUP)
g = sql("SELECT id, name, capacity, weekday, starts_on, grade_min, grade_max, status FROM program_groups")
check("a valid group is added", msg(h) == "group-saved" and len(g) == 1 and g[0]["capacity"] == 10 and g[0]["weekday"] == 2, g)
GID = g[0]["id"] if g else 0
st, h, _ = admin("POST", "/programs/academy/groups", GROUP)
check("two groups cannot share a name", msg(h) == "invalid" and len(sql("SELECT 1 FROM program_groups")) == 1)
st, h, _ = admin("POST", f"/programs/academy/groups/{GID}", {**GROUP, "capacity": "12", "status": "closed"})
g = sql(f"SELECT capacity, status FROM program_groups WHERE id={GID}")
check("a group can be edited and closed to new offers", msg(h) == "group-saved" and g == [{"capacity": 12, "status": "closed"}], g)
st, _, html = admin("GET", "/programs/academy")
check("the page lists it with its seats", "Tuesday 3rd-4th" in html and "0/12 seats" in html and "closed" in html)

print("\n=== closing, audit, access ===")
st, h, _ = admin("POST", "/programs/academy/status", {"status": "closed"})
check("the academy can be closed to new applications", msg(h) == "closed" and academy()["status"] == "closed")
actions = {r["action"] for r in sql("SELECT action FROM audit_log WHERE action LIKE 'program.%' OR action LIKE 'group.%' "
                                    "OR action LIKE 'waiver.%'")}
check("settings, status, groups and waivers are all audited",
      {"program.update", "program.open", "program.close", "group.create", "group.update", "waiver.create"} <= actions, actions)
st, _, _ = admin("POST", "/programs/academy/settings", SETTINGS, headers={"Sec-Fetch-Site": "cross-site"})
check("a cross-site post is refused before anything changes", st == 403, st)
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _, _ = admin("GET", "/programs/academy")
check("a coach cannot open the settings", st == 403, st)
st, h, _ = admin("POST", "/programs/academy/status", {"status": "open"})
check("or change them", st == 403 and academy()["status"] == "closed", st)
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")
st, _, _ = admin("GET", "/programs/no-such-program")
check("an unknown program is a 404", st == 404, st)

check.finish()
