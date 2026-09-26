"""Co-guardians and devices (src/portal/guardians.js, data.js).

A second guardian sees and changes everything about a family's children, so
the path in is narrow: only the owner invites (after a recent sign-in), only the
invited mailbox can accept, one family per account. Proved here end to end with
the loopback mail sink, including the invitee's very first sign-in while the
portal is invite-only.
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight
from _portal import (BASE, P, Checker, cookie_value, get, make_account, mint_session, post, require_portal,
                     session_cookies, sql)

preflight(BASE)
settings = require_portal()
if settings.get("PORTAL_SIGNUP_ENABLED") == "true":
    sys.exit("\nREFUSING TO RUN.\n  This suite tests the invite-only pilot; unset PORTAL_SIGNUP_ENABLED in .dev.vars.\n")
check = Checker()
captured = []


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            captured.append(json.loads(raw))
        except json.JSONDecodeError:
            captured.append({})
        body = json.dumps({"id": f"sink-{len(captured)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def settle(n, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline and len(captured) < n:
        time.sleep(0.1)
    time.sleep(0.5)


def mail_to(addr):
    return [m for m in captured if addr in (m.get("to") or [])]


def token_in(mail, path):
    m = re.search(re.escape(path) + r"#t=([A-Za-z0-9_-]{43})", mail.get("text", "") + mail.get("html", ""))
    return m.group(1) if m else None


def invite(sess, email):
    return post(P + "/guardians/invite", {"invite_email": email}, cookies=sess)


def sign_in_by_link(email, ip):
    """The invitee's real first sign-in: ask for a link, follow it in the same browser."""
    captured.clear()
    st, _, sc, _ = post(P + "/auth/email", {"email": email, "cf-turnstile-response": "d"}, ip=ip)
    bind = cookie_value(sc, "__Host-tns_bind")
    settle(1)
    mails = mail_to(email)
    tok = token_in(mails[0], "/auth/email/verify") if mails else None
    if not tok:
        return None
    st, _, sc, _ = post(P + "/auth/email/verify", {"t": tok}, cookies={"__Host-tns_bind": bind}, ip=ip)
    return cookie_value(sc, "__Host-tns_session")


server = ThreadingHTTPServer(("127.0.0.1", 8799), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    for t in ["player_medical", "household_emergency_contacts", "household_invites", "household_members",
              "sessions", "account_identities", "rate_limits", "households", "accounts", "email_budget"]:
        sql(f"DELETE FROM {t}")
    sql("DELETE FROM players WHERE household_id IS NOT NULL")

    OWNER = make_account("owner@example.com")
    SO = session_cookies(mint_session(OWNER))
    post(P + "/family/setup", {"guardian_name": "Olive Owner", "phone": "(615) 555-0100", "relationship": "Mother"}, cookies=SO)
    post(P + "/children", {"child_name": "Owner Kid", "date_of_birth": "2015-06-06", "grade": "5",
                           "school": "Owner School", "shirt_size": "YL"}, cookies=SO)
    KID = sql("SELECT id FROM players WHERE display_name='Owner Kid'")[0]["id"]

    print("\n=== the owner's view ===")
    st, _, _, html = get(P + "/guardians", cookies=SO)
    check("the guardians page lists the owner", st == 200 and "Olive Owner" in html and "owner" in html, st)
    check("and says plainly what a guardian can see before inviting anyone",
          "can see and change everything about your children" in html)

    print("\n=== inviting ===")
    stale = session_cookies(mint_session(OWNER, recent=False))
    st, _, _, html = invite(stale, "coparent@example.com")
    check("an invitation needs a recent sign-in", st == 403 and "sign in again" in html.lower(), st)
    check("so nothing was created", sql("SELECT 1 FROM household_invites") == [])
    st, _, _, html = invite(SO, "not-an-email")
    check("a malformed address is refused", st == 400 and 'href="#invite_email"' in html, st)
    st, _, _, html = invite(SO, "Owner@Example.com")
    check("inviting yourself is refused", st == 400 and "your own address" in html, st)
    captured.clear()
    st, h, _, _ = invite(SO, "CoParent@Example.com")
    check("a valid invitation is sent", st == 303 and "notice=invited" in h.get("Location", ""), st)
    settle(1)
    inv_mail = mail_to("CoParent@Example.com")
    check("one email to the invitee", len(inv_mail) == 1, [m.get("to") for m in captured])
    INV = token_in(inv_mail[0], "/invite") if inv_mail else None
    check("carrying a single-use token in the URL fragment", INV is not None)
    body = (inv_mail[0].get("text", "") + inv_mail[0].get("html", "")) if inv_mail else ""
    check("saying what a guardian can see", "see and update everything" in body)
    check("naming no child", "Owner Kid" not in body)
    rows = sql("SELECT * FROM household_invites")
    check("stored as a hash, never the token", rows and INV and INV not in json.dumps(rows), json.dumps(rows)[:160])
    audit = sql("SELECT actor, detail, subject_type FROM audit_log WHERE action='portal.invite_create'")
    check("audited by account and household, never the invitee's address",
          audit and "coparent" not in json.dumps(audit).lower(), audit)

    print("\n=== the invitation page ===")
    st, h, sc, html = get(P + "/invite")
    check("it opens signed out", st == 200 and "invited" in html, st)
    check("it accepts nothing by being opened", ".submit(" not in html and "requestSubmit" not in html)
    check("its script runs by hash", "script-src 'sha256-" in {k.lower(): v for k, v in h.items()}.get("content-security-policy", ""))
    check("and it repeats what a guardian can see", "see and be able to change everything" in html)
    st, _, _, html = post(P + "/invite/accept", {"t": INV})
    check("accepting while signed out says to sign in as the invited address, masked",
          st == 200 and "c•••@example.com" in html and "coparent@example.com" not in html, st)

    print("\n=== the invitee's first sign-in, while the portal is invite-only ===")
    COP = sign_in_by_link("coparent@example.com", ip="10.80.0.1")
    check("an invited address is sent a sign-in link and gets an account", COP is not None)
    SC = session_cookies(COP) if COP else {}
    stranger = make_account("stranger@example.com")
    SS = session_cookies(mint_session(stranger))
    st, _, _, html = post(P + "/invite/accept", {"t": INV}, cookies=SS)
    check("someone signed in as a different address cannot accept it", st == 403 and "c•••@example.com" in html, st)
    st, h, _, _ = post(P + "/invite/accept", {"t": INV}, cookies=SC)
    check("the invited address accepts it", st == 303 and "notice=joined" in h.get("Location", ""), (st, h.get("Location")))
    cop_id = sql("SELECT id FROM accounts WHERE email_norm='coparent@example.com'")[0]["id"]
    member = sql(f"SELECT role FROM household_members WHERE account_id={cop_id}")
    check("and joins as a guardian", member == [{"role": "guardian"}], member)
    st, _, _, html = post(P + "/invite/accept", {"t": INV}, cookies=SC)
    check("the invitation cannot be used twice", st == 400 and "expired" in html, st)

    print("\n=== sharing the family ===")
    st, _, _, html = get(P + "/?notice=joined", cookies=SC)
    check("the guardian lands on the family, welcomed, and sees the children",
          st == 200 and "Owner Kid" in html and "joined the family" in html, st)
    st, h, _, _ = post(P + f"/children/{KID}/medical", {"medical_status": "none_declared"}, cookies=SC)
    check("and can update them", st == 303 and sql(f"SELECT updated_by FROM player_medical WHERE player_id={KID}")
          == [{"updated_by": f"account:{cop_id}"}])
    st, _, _, _ = invite(SC, "third@example.com")
    check("a guardian cannot invite others (owner only)", st == 404, st)
    st, _, _, _ = post(P + "/guardians/remove", {"account_id": str(OWNER)}, cookies=SC)
    check("a guardian cannot remove anyone", st == 404 and sql(f"SELECT 1 FROM household_members WHERE account_id={OWNER}") != [])
    st, _, _, html = get(P + "/guardians", cookies=SC)
    check("the guardian's page offers leaving, not inviting", "Leave this family" in html and "Send invitation" not in html)

    print("\n=== removing a guardian ===")
    st, _, _, _ = post(P + "/guardians/remove", {"account_id": str(cop_id)}, cookies=stale)
    check("removing needs a recent sign-in", st == 403, st)
    st, h, _, _ = post(P + "/guardians/remove", {"account_id": str(cop_id)}, cookies=SO)
    check("the owner removes the guardian", st == 303 and "notice=removed" in h.get("Location", ""), st)
    st, h, _, body = get(P + f"/children/{KID}", cookies=SC)
    check("who immediately loses access to the children (sent back to family setup, nothing shown)",
          st == 303 and h.get("Location") == P + "/" and "Owner Kid" not in body, (st, h.get("Location")))
    st, _, _, html = get(P + "/", cookies=SC)
    check("and is back to 'set up your family'", "Set up your family" in html)
    st, _, _, _ = post(P + "/guardians/remove", {"account_id": str(OWNER)}, cookies=SO)
    check("the owner cannot remove themselves", st == 404, st)

    print("\n=== leaving ===")
    captured.clear()
    invite(SO, "coparent@example.com")
    settle(1)
    tok = token_in(mail_to("coparent@example.com")[0], "/invite") if mail_to("coparent@example.com") else ""
    post(P + "/invite/accept", {"t": tok}, cookies=SC)
    st, h, _, _ = post(P + "/guardians/leave", {}, cookies=SC)
    check("a guardian can leave", st == 303 and sql(f"SELECT 1 FROM household_members WHERE account_id={cop_id}") == [])
    st, _, _, _ = post(P + "/guardians/leave", {}, cookies=SO)
    check("the owner cannot leave (it would orphan the family)",
          st == 404 and sql(f"SELECT 1 FROM household_members WHERE account_id={OWNER}") != [])

    print("\n=== cancelled, expired, limited, already taken ===")
    captured.clear()
    invite(SO, "later@example.com")
    settle(1)
    later_tok = token_in(mail_to("later@example.com")[0], "/invite") if mail_to("later@example.com") else ""
    st, h, _, _ = post(P + "/guardians/invite/cancel", {"email": "later@example.com"}, cookies=SO)
    check("the owner can cancel a pending invitation", st == 303 and "notice=cancelled" in h.get("Location", ""))
    captured.clear()
    post(P + "/auth/email", {"email": "later@example.com", "cf-turnstile-response": "d"}, ip="10.80.0.2")
    settle(0)
    check("once cancelled, the address is no longer eligible to sign in", mail_to("later@example.com") == [])
    later = make_account("later@example.com")
    st, _, _, html = post(P + "/invite/accept", {"t": later_tok}, cookies=session_cookies(mint_session(later)))
    check("and the cancelled link is dead", st == 400 and "expired" in html, st)

    captured.clear()
    invite(SO, "slow@example.com")
    settle(1)
    slow_tok = token_in(mail_to("slow@example.com")[0], "/invite") if mail_to("slow@example.com") else ""
    sql("UPDATE household_invites SET expires_at='2000-01-01T00:00:00.000Z' WHERE invited_email_norm='slow@example.com'")
    slow = make_account("slow@example.com")
    st, _, _, html = post(P + "/invite/accept", {"t": slow_tok}, cookies=session_cookies(mint_session(slow)))
    check("an expired invitation is refused", st == 400 and "expired" in html, st)

    sql("DELETE FROM household_invites")
    sql("DELETE FROM rate_limits")
    for i in range(3):
        invite(SO, f"pending{i}@example.com")
    st, _, _, html = invite(SO, "pending3@example.com")
    check("at most three invitations wait at once", st == 400 and "Cancel one first" in html, st)

    other = make_account("other-owner@example.com")
    SOO = session_cookies(mint_session(other))
    post(P + "/family/setup", {"guardian_name": "Otto Other", "phone": "(615) 555-0101", "relationship": "Father"}, cookies=SOO)
    post(P + "/guardians/invite/cancel", {"email": "pending0@example.com"}, cookies=SO)
    captured.clear()
    invite(SO, "other-owner@example.com")
    settle(1)
    oo_tok = token_in(mail_to("other-owner@example.com")[0], "/invite") if mail_to("other-owner@example.com") else ""
    st, _, _, html = post(P + "/invite/accept", {"t": oo_tok}, cookies=SOO)
    check("someone already in a family cannot be pulled into another", st == 409 and "already part of a family" in html, st)
    check("so they still have exactly one family",
          len(sql(f"SELECT 1 FROM household_members WHERE account_id={other}")) == 1)

    print("\n=== devices ===")
    extra = mint_session(OWNER)
    st, _, _, html = get(P + "/account", cookies=SO)
    check("the account page lists where you're signed in", st == 200 and "signed in" in html and "This device" in html, st)
    st, h, _, _ = post(P + "/account/signout-others", {}, cookies=SO)
    check("'sign out everywhere else' works", st == 303 and "notice=signedout" in h.get("Location", ""), st)
    st, _, _, html = get(P + "/", cookies=session_cookies(extra))
    check("the other device is signed out", "Email me a sign-in link" in html)
    st, _, _, html = get(P + "/", cookies=SO)
    check("this one is not", "Sign out" in html and "Email me a sign-in link" not in html)

finally:
    server.shutdown()

check.finish()
