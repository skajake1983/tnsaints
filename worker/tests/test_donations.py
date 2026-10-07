"""Donations and their receipts (admin/routes/donations.js, donations/donations.js).

Asserted: no receipt is issued while receipts are switched off or the
organisation's details are missing; a receipt states what the IRS rules ask —
amount or (unvalued) description, what was given in return and the deductible
remainder, or that nothing was — and is frozen once issued (the database
refuses changes); a mistake is voided with a reason and stays on record;
what a donor received cannot exceed what they gave; the treasurer may read and
nobody but admins may change; the audit log carries no names or amounts.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, WORKER_DIR, Checker, sql

preflight(BASE)
check = Checker()
ME = staff_email()
A = "/__admin"
dev = {}
for line in open(os.path.join(WORKER_DIR, ".dev.vars"), encoding="utf-8"):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.strip().split("=", 1)
        dev[k] = v
if dev.get("DONATIONS_ENABLED") != "true":
    sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs DONATIONS_ENABLED=true (see .dev.vars.example).\n")


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


sql("DELETE FROM donations")
sql("DELETE FROM board_members")
sql("DELETE FROM app_settings WHERE key LIKE 'donations.%'")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
year = one("SELECT strftime('%Y', 'now', '-5 hours') AS y")["y"]

print("\n=== recording gifts ===")
st, _, html = admin("POST", "/donations", {"donor_name": "Dana Donor", "received_on": f"{year}-03-01", "kind": "cash",
                                         "amount": "50.00", "method": "check", "goods_services_value": "75.00",
                                         "goods_services_description": "Gala dinner"})
check("what the donor received cannot be worth more than they gave", st == 400 and "cannot be worth more" in html, st)
st, _, html = admin("POST", "/donations", {"donor_name": "Dana Donor", "received_on": f"{year}-03-01", "kind": "noncash"})
check("a non-cash gift must be described", st == 400 and "Describe what was given" in html, st)
st, h, _ = admin("POST", "/donations", {"donor_name": "Dana Donor", "received_on": f"{year}-03-01", "kind": "cash", "amount": "500.00",
                                        "method": "check", "goods_services_value": "40.00", "goods_services_description": "Gala dinner for one"})
GIFT = one("SELECT id FROM donations WHERE amount_cents = 50000")["id"]
check("a $500 gift with a $40 dinner is recorded", "msg=recorded" in loc(h), loc(h))
admin("POST", "/donations", {"donor_name": "Dana Donor", "received_on": f"{year}-06-01", "kind": "noncash",
                             "noncash_description": "Twenty basketballs"})
BALLS = one("SELECT id FROM donations WHERE kind='noncash'")["id"]
st, _, html = admin("GET", "/donations")
check("the year's list counts gifts that need a receipt", st == 200 and "Dana Donor" in html and "$500.00" in html, st)

print("\n=== no receipt without the organisation's details ===")
st, h, _ = admin("POST", f"/donations/{GIFT}/receipt")
check("issuing before the details are entered is refused", "msg=settings" in loc(h)
      and one(f"SELECT receipt_issued_at FROM donations WHERE id={GIFT}")["receipt_issued_at"] is None, loc(h))
st, h, _ = admin("POST", "/donations/settings", {"legal_name": "Tennessee Saints Basketball Academy, Inc.", "ein": "123456789",
                                                 "determination_date": "2027-01-15", "signer_name": "Bea Chair", "signer_title": "Board Chair"})
check("an EIN must look like 12-3456789", "msg=invalid" in loc(h), loc(h))
admin("POST", "/donations/settings", {"legal_name": "Tennessee Saints Basketball Academy, Inc.", "ein": "12-3456789",
                                      "determination_date": "2027-01-15", "signer_name": "Bea Chair", "signer_title": "Board Chair"})
st, _, html = admin("GET", f"/donations/{GIFT}")
check("the preview states the amount, what was received, and the deductible part",
      "contribution of $500.00" in html and "Gala dinner for one" in html and "$40.00" in html and "$460.00" in html
      and "EIN 12-3456789" in html and "501(c)(3)" in html, st)

print("\n=== issued, and frozen ===")
st, h, _ = admin("POST", f"/donations/{GIFT}/receipt")
r = one(f"SELECT receipt_number, receipt_text FROM donations WHERE id={GIFT}")
check("the receipt is issued and numbered", "msg=issued" in loc(h) and r["receipt_number"] == f"TS-{year}-0001", (loc(h), r))
sql(f"UPDATE donations SET amount_cents = 1 WHERE id={GIFT}")
check("the database refuses to change an issued gift", one(f"SELECT amount_cents FROM donations WHERE id={GIFT}")["amount_cents"] == 50000)
st, h, _ = admin("POST", f"/donations/{GIFT}/receipt")
check("issuing again does nothing new", "msg=already" in loc(h)
      and one(f"SELECT receipt_number FROM donations WHERE id={GIFT}")["receipt_number"] == f"TS-{year}-0001", loc(h))
admin("POST", f"/donations/{BALLS}/receipt")
balls = one(f"SELECT receipt_number, receipt_text FROM donations WHERE id={BALLS}")
check("a non-cash receipt describes the gift and does not value it", balls["receipt_number"] == f"TS-{year}-0002"
      and "Twenty basketballs" in balls["receipt_text"] and "does not assign a value" in balls["receipt_text"]
      and "No goods or services were provided" in balls["receipt_text"] and "$" not in balls["receipt_text"].split("Dear")[1], balls)
st, h, _ = admin("POST", f"/donations/{GIFT}/void", {"reason": ""})
check("voiding needs a reason", "msg=invalid" in loc(h), loc(h))
st, h, _ = admin("POST", f"/donations/{GIFT}/void", {"reason": "Check returned"})
v = one(f"SELECT voided_at IS NOT NULL AS voided, void_reason, receipt_text IS NOT NULL AS kept FROM donations WHERE id={GIFT}")
check("a void keeps the gift and its receipt on record, marked", v == {"voided": 1, "void_reason": "Check returned", "kept": 1}, v)
sql(f"DELETE FROM donations WHERE id={GIFT}")
check("and a receipted gift cannot be deleted", one(f"SELECT COUNT(*) AS n FROM donations WHERE id={GIFT}")["n"] == 1)
st, _, html = admin("GET", f"/donations/summary?year={year}&donor=Dana%20Donor")
check("the annual statement leaves out voided gifts", st == 200 and "Twenty basketballs" in html and "$500.00" not in html, st)
check("the audit log has no names or amounts",
      one("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'donation.%' AND (detail LIKE '%Dana%' OR detail LIKE '%500%')")["n"] == 0)

print("\n=== who may see ===")
role("board")
st, _, _ = admin("GET", "/donations")
check("a board member who is not the treasurer cannot", st == 403, st)
sql("INSERT INTO board_members (email, name, office, voting, term_start, created_by, created_at, updated_at) "
    f"VALUES ('{ME}', 'Tia Treasurer', 'treasurer', 1, '2026-01-01', 'test', 'n', 'n')")
st, _, html = admin("GET", "/donations")
check("the treasurer can read", st == 200 and "Dana Donor" in html and "Record a gift" not in html, st)
st, _, _ = admin("POST", "/donations", {"donor_name": "X", "received_on": f"{year}-01-01", "kind": "cash", "amount": "5", "method": "cash"})
check("but not change anything", st == 403, st)
role("coach")
st, _, _ = admin("GET", "/donations")
check("a coach cannot see donations", st == 403, st)
role("admin")

print("\n=== switched off ===")
UNIT = r"""
import { fakeD1 } from './tests/_d1_fake.mjs';
import { issueReceipt } from './src/donations/donations.js';
const DB = fakeD1();
DB.raw.prepare(`INSERT INTO donations (donor_name, received_on, kind, amount_cents, method, recorded_by, created_at, updated_at)
  VALUES ('Off Donor', '2027-01-02', 'cash', 30000, 'check', 'test', 'n', 'n')`).run();
for (const [k, v] of [['legal_name', 'Org'], ['ein', '12-3456789'], ['determination_date', '2027-01-01'], ['signer_name', 'S'], ['signer_title', 'T']]) {
  DB.raw.prepare(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, 'test', 'n')`).run(`donations.${k}`, v);
}
const off = await issueReceipt({ DB, DONATIONS_ENABLED: 'false' }, 1, 'admin');
const unset = await issueReceipt({ DB }, 1, 'admin');
console.log(JSON.stringify({ off: off.result, unset: unset.result,
  issued: DB.raw.prepare('SELECT receipt_issued_at FROM donations').get().receipt_issued_at }));
"""
res = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads(res.stdout.decode().strip().splitlines()[-1])
except Exception:
    u = None
check("with DONATIONS_ENABLED off, or unset, no receipt is issued",
      u == {"off": "disabled", "unset": "disabled", "issued": None}, (u, res.stderr.decode()[-300:]))

check.finish()
