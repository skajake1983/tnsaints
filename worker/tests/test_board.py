"""Non-profit governance: the board's records (admin/routes/board.js, governance/board.js).

Asserted: a board member signs in to the board pages and NOTHING about
children (roster, families, CRM, teams all refused); only admins and the
serving secretary record meetings; quorum is snapshotted from attendance and a
motion cannot be decided without it; a recusal must give its reason; a decided
motion's votes and approved minutes are locked by the database; documents are
SharePoint links only; recurring deadlines roll forward when done and reach the
daily brief; each member signs one disclosure a year, and only admins see
everyone's.
"""
import os
import re
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


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


def loc(h):
    return h.get("location", "").replace(A, "", 1)


def role(r):
    sql(f"UPDATE staff SET role='{r}' WHERE email_norm='{ME}'")


for t in ["motion_votes", "board_motions", "meeting_attendance", "board_action_items", "coi_disclosures", "board_meetings",
          "board_documents", "board_members"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM compliance_items WHERE seed_key IS NULL")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
today = one("SELECT date('now', '-5 hours') AS d")["d"]

print("\n=== members ===")
st, _, html = admin("POST", "/board/members", {"name": "", "email": "bad", "office": "chair", "term_start": ""})
check("a member needs a name, email and term start", st == 400 and "Enter their name." in html, st)
for name, email, office, voting in (("Bea Chair", "bea@example.com", "chair", "1"), ("Sam Secretary", ME, "secretary", "1"),
                                    ("Tom Treasurer", "tom@example.com", "treasurer", "1"), ("Nan Nonvoting", "nan@example.com", "director", "")):
    fields = {"name": name, "email": email, "office": office, "term_start": "2026-01-01", "term_end": "2028-12-31"}
    if voting:
        fields["voting"] = voting
    admin("POST", "/board/members", fields)
st, _, html = admin("GET", "/board/members")
check("serving members are listed with their offices", st == 200 and "Bea Chair" in html and "Secretary" in html and "(non-voting)" not in html)
BEA = one("SELECT id FROM board_members WHERE email='bea@example.com'")["id"]
SAM = one(f"SELECT id FROM board_members WHERE email='{ME}'")["id"]
TOM = one("SELECT id FROM board_members WHERE email='tom@example.com'")["id"]
NAN = one("SELECT id FROM board_members WHERE email='nan@example.com'")["id"]

st, _, html = admin("POST", "/board/members", {"name": "Odd", "email": "odd@example.com", "office": "constructor",
                                              "term_start": "2026-01-01"})
check("an office that is not on the list is refused, not a crash", st == 400, st)
st, _, html = admin("POST", "/board/members", {"name": "Odd", "email": "odd@example.com", "office": "director",
                                              "term_start": "2026-02-31"})
check("a date that does not exist is refused", st == 400 and "Enter when the term starts." in html, st)
# Next term's row for the sitting secretary, as a director: it must not take
# the secretary's rights away before it starts.
admin("POST", "/board/members", {"name": "Sam Secretary", "email": ME, "office": "director", "voting": "1",
                                 "term_start": "2099-01-01"})
ELECT = one(f"SELECT id FROM board_members WHERE email='{ME}' AND term_start='2099-01-01'")["id"]
st, _, html = admin("GET", "/board/members")
check("a member-elect is listed as not started", "(not started)" in html)
admin("POST", "/board/members", {"name": "Fay Future", "email": "fay@example.com", "office": "treasurer", "voting": "1",
                                 "term_start": today})
FAY = one("SELECT id FROM board_members WHERE email='fay@example.com'")["id"]
st, h, _ = admin("POST", f"/board/members/{FAY}/end")
check("ending a term the day it starts works (no end date before its start)", "msg=ended" in loc(h)
      and one(f"SELECT ended_at IS NOT NULL AS e, term_end FROM board_members WHERE id={FAY}") == {"e": 1, "term_end": None}, loc(h))

print("\n=== a board member sees the board and nothing about children ===")
role("board")
st, _, html = admin("GET", "/board")
check("the board pages open", st == 200, st)
menu = re.findall(r'<nav>(.*?)</nav>', html, re.S)
check("the menu offers the board, donations and their profile, and no page about children",
      menu and all(f'>{x}<' in menu[0] for x in ("Board", "Donations", "Profile"))
      and not any(f'>{x}<' in menu[0] for x in ("Roster", "Families", "CRM", "Teams", "Enrollments", "Evaluations")), menu[:1])
st, h, _ = admin("GET", "/")
check("their home is the board", st == 303 and h.get("location", "").endswith("/board"), (st, h.get("location")))
for path in ["/api/roster", "/families", "/crm", "/teams", "/billing", "/enrollments", "/users", "/clearances"]:
    st, _, _ = admin("GET", path)
    check(f"but not {path}", st == 403, st)

print("\n=== a meeting, as the board secretary ===")
st, h, _ = admin("POST", "/board/meetings", {"kind": "regular", "title": "October board meeting", "starts_at": f"{today}T18:00",
                                            "location": "Library room", "agenda": "1. Budget\n2. Camp"})
check("the secretary schedules a meeting", st == 303 and "msg=added" in loc(h), (st, loc(h)))
MEET = one("SELECT id FROM board_meetings")["id"]
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions", {"title": "Approve the 2027 budget", "moved_by": str(BEA), "seconded_by": str(TOM)})
MOTION = one("SELECT id FROM board_motions")["id"]
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions/{MOTION}/votes", {f"v{BEA}": "yes"})
check("a motion cannot be decided before attendance shows quorum", "msg=no-quorum" in loc(h), loc(h))
admin("POST", f"/board/meetings/{MEET}/attendance", {f"m{BEA}": "present", f"m{SAM}": "remote", f"m{TOM}": "absent", f"m{NAN}": "present"})
mt = one(f"SELECT voting_members, quorum_present, status FROM board_meetings WHERE id={MEET}")
check("attendance snapshots quorum: 2 of 3 voting members (the non-voting one does not count)",
      mt == {"voting_members": 3, "quorum_present": 2, "status": "held"}, mt)
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions/{MOTION}/votes", {f"v{BEA}": "yes", f"v{SAM}": ""})
check("every member present must be given a vote: a skipped one is not counted as yes", "msg=incomplete" in loc(h)
      and one(f"SELECT status FROM board_motions WHERE id={MOTION}")["status"] == "pending", loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions/{MOTION}/votes", {f"v{BEA}": "yes", f"v{SAM}": "recused", f"r{SAM}": ""})
check("a recusal without a reason is refused", "msg=incomplete" in loc(h), loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions", {"title": "Ghost motion", "moved_by": "999999"})
check("a motion moved by someone who is not a member is refused, not a crash", st == 303 and "msg=invalid" in loc(h), (st, loc(h)))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions/{MOTION}/votes",
                 {f"v{BEA}": "yes", f"v{SAM}": "recused", f"r{SAM}": "Spouse is a vendor on the budget"})
check("with one yes and one recusal, the motion carries", "msg=carried" in loc(h)
      and one(f"SELECT status FROM board_motions WHERE id={MOTION}")["status"] == "carried", loc(h))
check("the recusal is on the record, with its reason",
      one(f"SELECT recusal_reason FROM motion_votes WHERE board_member_id={SAM}")["recusal_reason"] == "Spouse is a vendor on the budget")
sql(f"INSERT INTO motion_votes (motion_id, board_member_id, vote, recorded_by, recorded_at) VALUES ({MOTION}, {TOM}, 'no', 'x', 'n')")
check("the database refuses a vote on a decided motion",
      one(f"SELECT COUNT(*) AS n FROM motion_votes WHERE motion_id={MOTION}")["n"] == 2)

print("\n=== minutes ===")
st, h, _ = admin("POST", f"/board/meetings/{MEET}/minutes/approve")
check("minutes cannot be approved before they are circulated", "msg=invalid" in loc(h), loc(h))
admin("POST", f"/board/meetings/{MEET}/minutes/save", {"minutes": "The board approved the budget. Sam recused."})
admin("POST", f"/board/meetings/{MEET}/minutes/circulate")
st, h, _ = admin("POST", f"/board/meetings/{MEET}/minutes/approve")
check("draft, circulated, approved", "msg=approved" in loc(h)
      and one(f"SELECT minutes_status FROM board_meetings WHERE id={MEET}")["minutes_status"] == "approved", loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/minutes/save", {"minutes": "Rewritten history"})
check("approved minutes are locked", "msg=locked" in loc(h)
      and one(f"SELECT minutes FROM board_meetings WHERE id={MEET}")["minutes"] == "The board approved the budget. Sam recused.", loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/attendance", {f"m{BEA}": "absent", f"m{SAM}": "absent", f"m{TOM}": "present"})
check("so is the attendance, and the quorum it showed", "msg=locked" in loc(h)
      and one(f"SELECT quorum_present FROM board_meetings WHERE id={MEET}")["quorum_present"] == 2, loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/motions", {"title": "Slipped in afterwards"})
check("and no motion can be added to it", "msg=invalid" in loc(h)
      and one(f"SELECT COUNT(*) AS n FROM board_motions WHERE meeting_id={MEET}")["n"] == 1, loc(h))
sql(f"UPDATE meeting_attendance SET status='absent' WHERE meeting_id={MEET}")
sql(f"UPDATE board_motions SET status='failed' WHERE id={MOTION}")
check("the database refuses it too, whatever the path",
      one(f"SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id={MEET} AND status='absent'")["n"] == 1
      and one(f"SELECT status FROM board_motions WHERE id={MOTION}")["status"] == "carried")

st, h, _ = admin("POST", "/board/meetings", {"kind": "special", "title": "Still the secretary", "starts_at": f"{today}T19:30"})
check("a member-elect row for next term leaves the sitting secretary's rights alone", st == 303, st)
sql(f"DELETE FROM board_meetings WHERE title='Still the secretary'")

print("\n=== an ordinary board member cannot record ===")
sql(f"UPDATE board_members SET office='director' WHERE id={SAM}")
st, _, _ = admin("POST", "/board/meetings", {"kind": "special", "title": "Sneaky", "starts_at": f"{today}T19:00"})
check("only the secretary or an admin schedules meetings", st == 403, st)
st, _, html = admin("GET", f"/board/meetings/{MEET}")
check("but every board member can read the record", st == 200 and "Approve the 2027 budget" in html and "Spouse is a vendor" in html, st)
sql(f"UPDATE board_members SET office='secretary' WHERE id={SAM}")

print("\n=== documents, compliance and disclosures ===")
role("admin")
st, h, _ = admin("POST", "/board/documents", {"title": "Bylaws", "category": "bylaws", "url": "https://evil.example/bylaws.pdf"})
check("a document link outside SharePoint is refused", "msg=host" in loc(h), loc(h))
st, h, _ = admin("POST", "/board/documents", {"title": "Bylaws", "category": "bylaws",
                                             "url": "https://tnsaints.sharepoint.com/sites/board/Bylaws.pdf", "effective_on": "2026-01-15"})
check("a SharePoint link is added", "msg=added" in loc(h) and one("SELECT COUNT(*) AS n FROM board_documents")["n"] == 1, loc(h))
st, _, html = admin("GET", "/board/compliance")
check("the compliance calendar starts from the seeded list, needing dates", st == 200 and "IRS Form 990" in html and "needs a date" in html)
ITEM = one("SELECT id FROM compliance_items WHERE seed_key='irs-1099'")["id"]
admin("POST", f"/board/compliance/{ITEM}/date", {"due_on": today})
st, _, html = admin("GET", "/brief")
check("a deadline due soon reaches the daily brief", "filing deadline" in html and "/__admin/board/compliance" in html)
admin("POST", f"/board/compliance/{ITEM}/done")
nxt = sql("SELECT status, due_on FROM compliance_items WHERE title LIKE '1099-NEC%' ORDER BY id")
check("done, and the next year's appears", len(nxt) == 2 and nxt[0]["status"] == "done" and nxt[1]["status"] == "open"
      and nxt[1]["due_on"] == f"{int(today[:4]) + 1}{today[4:]}", nxt)
admin("POST", "/board/compliance", {"title": "Monthly payroll filing", "category": "payroll", "due_on": "2027-01-31",
                                    "recurrence": "monthly"})
MONTHLY = one("SELECT id FROM compliance_items WHERE title='Monthly payroll filing'")["id"]
import threading  # noqa: E402
clicks = [threading.Thread(target=admin, args=("POST", f"/board/compliance/{MONTHLY}/done")) for _ in range(2)]
for t in clicks:
    t.start()
for t in clicks:
    t.join()
rolled = sql("SELECT status, due_on FROM compliance_items WHERE title='Monthly payroll filing' ORDER BY id")
check("Jan 31 monthly is next due Feb 28, and a double click makes one, not two",
      [r["due_on"] for r in rolled] == ["2027-01-31", "2027-02-28"] and rolled[1]["status"] == "open", rolled)
NEXT = one("SELECT id FROM compliance_items WHERE title='Monthly payroll filing' AND status='open'")["id"]
st, h, _ = admin("POST", f"/board/compliance/{NEXT}/date", {"due_on": "2027-02-31"})
check("a date that does not exist is refused", "msg=invalid" in loc(h), loc(h))
st, h, _ = admin("POST", "/board/compliance", {"title": "Bad owner", "category": "other", "owner_email": "not an email"})
check("an owner that is not an email address is refused", "msg=invalid" in loc(h), loc(h))
st, h, _ = admin("POST", f"/board/meetings/{MEET}/actions", {"title": "Bad owner", "owner_email": "x" * 300})
check("so is an action item's", "msg=invalid" in loc(h), loc(h))
st, _, html = admin("GET", "/board/members?msg=toString")
check("a message name that is not a message shows nothing", st == 200 and "function" not in html, st)
role("board")
st, h, _ = admin("POST", "/board/disclosures", {"has_conflicts": "1", "details": "", "signature": "Sam Secretary"})
check("declaring an interest needs a description", "msg=invalid" in loc(h), loc(h))
st, h, _ = admin("POST", "/board/disclosures", {"has_conflicts": "1", "details": "Spouse owns a print shop we use.", "signature": "Sam Secretary"})
check("a member signs this year's disclosure", "msg=signed" in loc(h), loc(h))
st, h, _ = admin("POST", "/board/disclosures", {"has_conflicts": "0", "signature": "Sam Secretary"})
check("once a year", "msg=exists" in loc(h), loc(h))
st, _, html = admin("GET", "/board/disclosures")
check("a board member sees their own, not everyone's", "You signed" in html and "who has disclosed" not in html)
check("the audit log does not say what was declared",
      one("SELECT COUNT(*) AS n FROM audit_log WHERE detail LIKE '%print shop%'")["n"] == 0)
role("admin")
st, _, html = admin("GET", "/board/disclosures")
check("an admin sees who has disclosed, and what", "who has disclosed" in html and "print shop" in html and "Not yet" in html)

st, _, html = admin("GET", "/users")
check("admins can give someone the board role", "board — board records" in html)

print("\n=== ending a term ===")
admin("POST", f"/board/members/{NAN}/end")
check("a term ends", one(f"SELECT ended_at IS NOT NULL AS ended FROM board_members WHERE id={NAN}")["ended"] == 1)

check.finish()
