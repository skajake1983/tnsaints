"""Website inquiries into the CRM (POST /api/lead, crm/intake.js) and the Inbox.

Asserted: each form purpose lands as a contact + inquiry (+ prospect child and
pipeline card, + a follow-up task), with only allow-listed fields kept; a
repeat submission does not duplicate the person, the child, the card or the
task; bots and floods are turned away; no email is sent per lead; staff see
inquiries in the Inbox and coaches do not.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email, _dev_vars
from _portal import BASE, Checker, make_account, sql

preflight(BASE)
if _dev_vars().get("LEADS_ENABLED") != "true":
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs LEADS_ENABLED=true (see .dev.vars.example).\n")
check = Checker()
ME = staff_email()
SITE = "https://tnsaints.com"


def lead(body, ip="10.90.0.1", origin=SITE, raw=None, ctype="application/json"):
    data = raw if raw is not None else json.dumps({"turnstile_token": "d", "elapsed_ms": 9000, **body}).encode()
    req = urllib.request.Request(BASE + "/api/lead", data=data, method="POST")
    req.add_header("Content-Type", ctype)
    if origin:
        req.add_header("Origin", origin)
    req.add_header("CF-Connecting-IP", ip)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except json.JSONDecodeError:
            return e.code, {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def admin(method, path, fields=None):
    data = urllib.parse.urlencode(fields or {}).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + "/__admin" + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Sec-Fetch-Site", "same-origin")
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), dict(r.headers), r.read().decode("utf-8", "replace")


PLAYER = {"purpose": "player-interest", "parent_name": "Pat Parent", "parent_email": "Pat.Parent@Example.com",
          "phone": "(615) 555-0100", "player_name": "Riley Parent", "grade": "4th", "school": "Hillsboro Elementary",
          "position": "Point Guard", "highlight_link": "", "player_notes": "Loves defense.", "sneaky_extra": "DROP-ME"}

for t in ["crm_tasks", "crm_opportunities", "crm_inquiries", "crm_prospect_players", "crm_contacts", "rate_limits",
          "email_budget", "household_members", "sessions", "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")

print("\n=== the front door ===")
st, r = lead(PLAYER, origin="https://evil.example")
check("another site cannot post", st == 403 and sql("SELECT 1 FROM crm_inquiries") == [], st)
st, r = lead({}, raw=b"purpose=general&name=x", ctype="application/x-www-form-urlencoded")
check("anything but JSON is refused", st == 400, st)
st, r = lead({**PLAYER, "turnstile_token": ""})
check("no Turnstile token, no entry", st == 403 and sql("SELECT 1 FROM crm_inquiries") == [], st)
st, r = lead({**PLAYER, "company": "Acme"})
check("a filled honeypot is thanked and nothing is kept", st == 200 and r.get("ok") and sql("SELECT 1 FROM crm_inquiries") == [], st)
st, r = lead({**PLAYER, "elapsed_ms": 500})
check("so is a form submitted inhumanly fast", st == 200 and sql("SELECT 1 FROM crm_inquiries") == [], st)
st, r = lead({"purpose": "donate", "name": "x"})
check("an unknown purpose is refused", st == 400 and "purpose" in r.get("errors", {}), (st, r))

print("\n=== academy interest ===")
st, r = lead({**PLAYER, "grade": "2nd", "school": "", "parent_email": "nope"})
check("bad fields are reported by name", st == 400 and {"grade", "school", "parent_email"} <= set(r.get("errors", {})), r)
st, r = lead(PLAYER)
check("a valid academy-interest form is accepted", st == 200 and r.get("ok"), (st, r))
c = sql("SELECT id, kind, name, email, email_norm, phone_norm, source FROM crm_contacts")
check("one contact, found by normalized email", len(c) == 1 and c[0]["email_norm"] == "pat.parent@example.com"
      and c[0]["kind"] == "family" and c[0]["phone_norm"] == "6155550100" and c[0]["source"] == "website:player", c)
i = sql("SELECT purpose, fields, message, ip_hash FROM crm_inquiries")
f = json.loads(i[0]["fields"]) if i else {}
check("the inquiry keeps the allow-listed fields and drops anything else",
      f.get("player_name") == "Riley Parent" and f.get("grade") == "4th" and "sneaky_extra" not in i[0]["fields"]
      and "DROP-ME" not in json.dumps(i), i)
check("a highlight video is optional", "highlight_link" in f and f["highlight_link"] is None, f)
check("the connection is kept only as a salted hash", i and i[0]["ip_hash"] and "10.90.0.1" not in i[0]["ip_hash"], i)
p = sql("SELECT name, grade_level, school, position FROM crm_prospect_players")
check("the child becomes a prospect", p == [{"name": "Riley Parent", "grade_level": 4, "school": "Hillsboro Elementary",
                                            "position": "Point Guard"}], p)
o = sql("SELECT pipeline, stage FROM crm_opportunities")
check("with a card in the family pipeline, at New", o == [{"pipeline": "family", "stage": "new"}], o)
t = sql("SELECT title, status, origin, due_on FROM crm_tasks")
check("and a follow-up task due tomorrow", len(t) == 1 and t[0]["title"] == "Respond to academy interest"
      and t[0]["origin"] == "auto:inquiry" and t[0]["due_on"], t)

st, r = lead({**PLAYER, "player_notes": "Also plays soccer."}, ip="10.90.0.2")
check("the same family again: a second inquiry", st == 200 and len(sql("SELECT 1 FROM crm_inquiries")) == 2)
check("but still one contact, one prospect child, one open card, one open task",
      len(sql("SELECT 1 FROM crm_contacts")) == 1 and len(sql("SELECT 1 FROM crm_prospect_players")) == 1
      and len(sql("SELECT 1 FROM crm_opportunities WHERE closed_at IS NULL")) == 1
      and len(sql("SELECT 1 FROM crm_tasks WHERE status='open'")) == 1)
st, r = lead({**PLAYER, "player_name": "Sam Parent", "grade": "6th"}, ip="10.90.0.3")
check("a sibling becomes a second prospect with their own card",
      len(sql("SELECT 1 FROM crm_prospect_players")) == 2 and len(sql("SELECT 1 FROM crm_opportunities")) == 2)

print("\n=== the other forms ===")
st, r = lead({"purpose": "general", "name": "Gen Eral", "email": "gen@example.com", "message": "Do you run summer camps?"}, ip="10.91.0.1")
check("general contact", st == 200 and sql("SELECT kind FROM crm_contacts WHERE email_norm='gen@example.com'") == [{"kind": "other"}])
st, r = lead({"purpose": "general", "name": "Gen Eral", "email": "gen@example.com", "message": "short"}, ip="10.91.0.2")
check("a too-short message is refused", st == 400 and "message" in r.get("errors", {}), r)
st, r = lead({"purpose": "coaching-interest", "coach_name": "Cora Coach", "coach_email": "cora@example.com",
              "coach_phone": "(615) 555-0177", "coach_role": "Skills Trainer", "coach_location": "Franklin, TN",
              "coach_experience": "Ten years of skills training."}, ip="10.91.0.3")
check("coaching interest lands in the coach pipeline", st == 200 and
      sql("SELECT o.pipeline FROM crm_opportunities o JOIN crm_contacts c ON c.id = o.contact_id WHERE c.email_norm='cora@example.com'")
      == [{"pipeline": "coach"}])
st, r = lead({"purpose": "sponsor-interest", "name": "Sal Sponsor", "email": "sal@acme.example", "organization": "Acme Hardware",
              "message": "We would like to sponsor jerseys."}, ip="10.91.0.4")
check("sponsorship lands in the sponsor pipeline with the organization",
      st == 200 and sql("SELECT organization FROM crm_contacts WHERE email_norm='sal@acme.example'") == [{"organization": "Acme Hardware"}]
      and sql("SELECT pipeline FROM crm_opportunities WHERE pipeline='sponsor'") != [])
st, r = lead({"purpose": "volunteer-interest", "name": "Val Volunteer", "email": "val@example.com", "message": "Happy to help."},
             ip="10.91.0.5")
check("a volunteer needs a phone number", st == 400 and "phone" in r.get("errors", {}), r)
st, r = lead({"purpose": "volunteer-interest", "name": "Val Volunteer", "email": "val@example.com", "phone": "615-555-0188",
              "message": "Happy to help."}, ip="10.91.0.6")
check("volunteering lands in the volunteer pipeline", st == 200 and sql("SELECT 1 FROM crm_opportunities WHERE pipeline='volunteer'") != [])

print("\n=== a family already on the portal ===")
acc = make_account("portal.family@example.com")
sql(f"INSERT INTO households (display_name, created_at, updated_at) VALUES ('The Portal family', datetime('now'), datetime('now'))")
hid = sql("SELECT id FROM households WHERE display_name='The Portal family'")[0]["id"]
sql(f"INSERT INTO household_members (household_id, account_id, role, created_at) VALUES ({hid}, {acc}, 'owner', datetime('now'))")
lead({**PLAYER, "parent_email": "portal.family@example.com", "player_name": "Pia Portal"}, ip="10.92.0.1")
c = sql("SELECT account_id, household_id FROM crm_contacts WHERE email_norm='portal.family@example.com'")
check("an inquiry from a portal family's address is attached to that family", c == [{"account_id": acc, "household_id": hid}], c)

print("\n=== floods, and no email per lead ===")
sql("DELETE FROM rate_limits")
statuses = [lead({"purpose": "general", "name": "Flood", "email": f"f{i}@example.com", "message": "Flooding the inbox."},
                 ip="10.93.0.1")[0] for i in range(6)]
check("five per connection per ten minutes, then 'try again later'", statuses[:5] == [200] * 5 and statuses[5] == 429, statuses)
check("no email was sent for any lead", sql("SELECT COALESCE(SUM(sent),0) AS n FROM email_budget")[0]["n"] == 0)

print("\n=== the Inbox ===")
st, _, html = admin("GET", "/inbox")
check("staff see new inquiries, with the child and a reply link",
      st == 200 and "Academy interest: Pat Parent" in html and "Riley Parent" in html and 'mailto:Pat.Parent@Example.com' in html, st)
check("and the portal family is flagged", "has a portal family" in html)
iid = sql("SELECT id FROM crm_inquiries ORDER BY id LIMIT 1")[0]["id"]
st, h, _ = admin("POST", f"/inbox/{iid}/handled")
check("an inquiry can be marked handled", st == 303 and sql(f"SELECT status, handled_by FROM crm_inquiries WHERE id={iid}")
      == [{"status": "handled", "handled_by": ME}])
st, _, html = admin("GET", "/inbox?status=handled")
check("and moves to the Handled list", "handled" in html and "Pat Parent" in html)
sql(f"UPDATE staff SET role='coach' WHERE email_norm='{ME}'")
st, _, _ = admin("GET", "/inbox")
check("a coach cannot open the Inbox", st == 403, st)
st, _, _ = admin("POST", f"/inbox/{iid}/handled")
check("or change it", st == 403, st)
sql(f"UPDATE staff SET role='admin' WHERE email_norm='{ME}'")

check.finish()
