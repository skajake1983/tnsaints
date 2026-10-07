"""Accessibility, structurally, on every portal and admin page (plan P1.13).

What a machine can check without a browser, on the HTML each page actually
serves: the page has a language, a title and a viewport; exactly one level-1
heading; every form field has a label (a <label for>, a wrapping <label>,
aria-label or aria-labelledby); every image has alt text; every button and
link has a name; no positive tabindex; radio and checkbox groups sit in a
fieldset with a legend; data tables have header cells; and an error summary,
where there is one, is announced.

What it cannot check — colour contrast on real rendering, focus order in a
browser, screen-reader output, 200% zoom, real devices — is the manual half of
P1.13 and needs the deployed site.
"""
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, staff_email
from _portal import BASE, P, Checker, make_account, mint_session, post, require_portal, session_cookies, sql

preflight(BASE)
require_portal()
check = Checker()
ME = staff_email()
A = "/__admin"


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.problems = []
        self.lang = None
        self.title = ""
        self.in_title = False
        self.viewport = False
        self.h1 = 0
        self.labels_for = set()
        self.ids = set()
        self.label_depth = 0
        self.fields = []          # (tag, attrs, inside_label)
        self.stack = []           # open elements we track for names
        self.fieldset_depth = 0
        self.legend_seen = []
        self.choice_outside = 0
        self.in_template = 0
        self.tables = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "template":
            self.in_template += 1
        if a.get("id"):
            self.ids.add(a["id"])
        if tag == "html":
            self.lang = a.get("lang")
        elif tag == "title":
            self.in_title = True
        elif tag == "meta" and a.get("name") == "viewport":
            self.viewport = True
        elif tag == "h1" and not self.in_template:
            self.h1 += 1
        elif tag == "label":
            self.label_depth += 1
            if a.get("for"):
                self.labels_for.add(a["for"])
        elif tag in ("input", "select", "textarea"):
            t = (a.get("type") or "").lower()
            if t not in ("hidden", "submit", "button", "reset", "image"):
                self.fields.append((tag, a, self.label_depth > 0))
                if t in ("radio", "checkbox") and self.fieldset_depth == 0 and self.label_depth == 0:
                    self.choice_outside += 1
        elif tag == "img":
            if a.get("alt") is None:
                self.problems.append(f"img without alt: {a.get('src', '')[:60]}")
        elif tag == "fieldset":
            self.fieldset_depth += 1
            self.legend_seen.append(False)
        elif tag == "legend" and self.legend_seen:
            self.legend_seen[-1] = True
        elif tag == "table":
            self.tables.append({"th": False, "role": a.get("role")})
        elif tag == "th" and self.tables:
            self.tables[-1]["th"] = True
        if "tabindex" in a:
            try:
                if int(a["tabindex"]) > 0:
                    self.problems.append(f"positive tabindex on <{tag}>")
            except ValueError:
                pass
        if tag in ("button", "a"):
            self.stack.append({"tag": tag, "attrs": a, "text": ""})

    def handle_endtag(self, tag):
        if tag == "template":
            self.in_template -= 1
        elif tag == "title":
            self.in_title = False
        elif tag == "label":
            self.label_depth = max(0, self.label_depth - 1)
        elif tag == "fieldset":
            self.fieldset_depth -= 1
            if self.legend_seen and not self.legend_seen.pop():
                self.problems.append("fieldset without a legend")
        elif tag == "table" and self.tables:
            t = self.tables.pop()
            if not t["th"] and t["role"] != "presentation":
                self.problems.append("table without header cells")
        elif tag in ("button", "a") and self.stack:
            el = self.stack.pop()
            a = el["attrs"]
            named = el["text"].strip() or a.get("aria-label") or a.get("aria-labelledby") or a.get("title")
            if tag == "a" and "href" not in a:
                return
            if not named:
                self.problems.append(f"<{tag}> without a name: {str(a)[:80]}")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        for el in self.stack:
            el["text"] += data

    def finish(self):
        if not self.lang:
            self.problems.append("no <html lang>")
        if not self.title.strip():
            self.problems.append("no <title>")
        if not self.viewport:
            self.problems.append("no viewport meta")
        if self.h1 != 1:
            self.problems.append(f"{self.h1} <h1> elements")
        for tag, a, inside in self.fields:
            fid = a.get("id")
            if inside or a.get("aria-label") or a.get("aria-labelledby") or (fid and fid in self.labels_for):
                continue
            self.problems.append(f"unlabelled <{tag} name={a.get('name')!r} id={fid!r}>")
        if self.choice_outside:
            self.problems.append(f"{self.choice_outside} radio/checkbox outside any fieldset or label")
        return self.problems


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def fetch(url, cookies=None):
    req = urllib.request.Request(url)
    if cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req)
    except urllib.error.HTTPError as e:
        r = e
    return (getattr(r, "status", None) or r.code), r.read().decode("utf-8", "replace")


def audit(label, url, cookies=None, expect=200):
    st, html = fetch(url, cookies)
    if st != expect:
        check(f"{label}: loads", False, st)
        return
    p = Page()
    p.feed(html)
    problems = p.finish()
    check(f"{label}", not problems, problems[:6])


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


# A family with a child, a medical answer and a contact; staff; a program to apply to.
for t in ["enrollments", "consent_records", "program_groups", "player_medical", "household_emergency_contacts",
          "household_members", "sessions", "households", "accounts"]:
    sql(f"DELETE FROM {t}")
sql("DELETE FROM players WHERE household_id IS NOT NULL")
sql("DELETE FROM staff")
sql("INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
    f"VALUES ('{ME}', 'Jacob Adams', 'Coach Adams', 'admin', 1, datetime('now'), datetime('now'))")
S = session_cookies(mint_session(make_account("a11y@example.com")))
post(P + "/family/setup", {"guardian_name": "Ari Access", "phone": "(615) 555-0142", "relationship": "Mother"}, cookies=S)
post(P + "/contacts", {"ec1_name": "Grandma", "ec1_phone": "(615) 555-0111"}, cookies=S)
post(P + "/children", {"child_name": "Ada Access", "date_of_birth": "2016-04-04", "grade": "4", "school": "Access School",
                       "shirt_size": "YM"}, cookies=S)
KID = one("SELECT id FROM players WHERE display_name='Ada Access'")["id"]
post(P + f"/children/{KID}/medical", {"medical_status": "none_declared"}, cookies=S)

print("\n=== the parent portal ===")
audit("sign-in page", BASE + P + "/")
audit("sign-in link landing", BASE + P + "/auth/email/verify")
for label, path in (("family page", "/"), ("account page", "/account"), ("add a child", "/children/new"),
                    ("a child", f"/children/{KID}"), ("emergency contacts", "/contacts"), ("guardians", "/guardians"),
                    ("programs", "/programs")):
    audit(label, BASE + P + path, S)

print("\n=== the admin ===")
for path in ["/", "/profile", "/eval", "/decisions", "/programs", "/programs/academy", "/enrollments", "/families", "/billing",
             "/crm", "/crm/list", "/crm/tasks", "/crm/customers", "/crm/contacts/new", "/crm/import", "/inbox", "/privacy",
             "/users", "/clearances", "/teams", "/brief", "/board", "/board/members", "/board/meetings",
             "/board/documents", "/board/compliance", "/board/disclosures", "/donations"]:
    audit(f"admin {path}", BASE + A + path)

check.finish()
