"""The website's events, in a real browser (the Events plan, phase EV4).

Serves the website (SITE_DIR, default the launch worktree) on 127.0.0.1:8090 —
an origin the local Worker allows (.dev.vars ALLOWED_ORIGINS) — and loads it
in headless Microsoft Edge against the local Worker, letting the page's own
script run, then reads the resulting page.

Asserted:
- the Upcoming events section appears with a card per listed, open event,
  and never a draft, past or unlisted one;
- the featured event is in the banner, with its button;
- each open event is a choice on the form;
- text from the API is shown as text, never run as HTML (an event named like
  an <img onerror> tag stays harmless);
- a deep link (?event=<id>) opens that event's form — its fields and its
  waiver — even when the event is unlisted;
- with no events, the section and banner stay hidden.

Skips (passes) if the website folder or Edge is not on this machine.
"""
import os
import re
import subprocess
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight
from _portal import BASE, Checker, sql

preflight(BASE)
check = Checker()
SITE_DIR = os.environ.get("SITE_DIR", r"C:\Dev\TNSaints\tnsaints-launch")
EDGE = os.environ.get("EDGE", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
if not os.path.isfile(os.path.join(SITE_DIR, "index.html")) or not os.path.isfile(EDGE):
    print("SKIP: website folder or Edge not found (SITE_DIR / EDGE)")
    check.finish()

W = "site-waiver-v1"


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 8090), partial(_Quiet, directory=SITE_DIR))
threading.Thread(target=server.serve_forever, daemon=True).start()
PROFILE = tempfile.mkdtemp(prefix="tns-edge-")


def render(path=""):
    """The page's DOM after its script has run (Edge's virtual time lets the fetches finish)."""
    out = subprocess.run([EDGE, "--headless=new", "--disable-gpu", f"--user-data-dir={PROFILE}", "--virtual-time-budget=8000",
                          "--dump-dom", f"http://127.0.0.1:8090/{path}"], capture_output=True, text=True, encoding="utf-8",
                         errors="replace", timeout=90)
    return out.stdout


def event(id_, kind, stored, mode, name, sessions, status="open", public=1, day="2099-07-11"):
    sql("INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, grade_min, grade_max, waiver_version_id, "
        "public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on, location, description) "
        f"VALUES ('{id_}', '{stored}', '{kind}', '{name}', '{status}', 'approval', 'free', 3, 8, '{W}', {public}, "
        f"'2099-07-10T23:59:00.000Z', 1, 'n', 'n', '{mode}', '{day}', 'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069', "
        "'Bring water and basketball shoes.')")
    for n, start, cap in sessions:
        sql("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, end_time, starts_on, capacity, status, created_at, "
            f"updated_at) VALUES ('{id_}', '{n}', '{n}', '{start}', '19:30', '{day}', {cap}, 'active', 'n', 'n')")


try:
    print("\n=== with no events ===")
    sql("DELETE FROM app_settings WHERE key = 'events.featured'")
    dom = render()
    check("the page loads", "Ready to connect?" in dom, len(dom))
    check("the section stays hidden and the banner stays down",
          re.search(r'<section id="events" hidden', dom) and 'class="event-banner show"' not in dom)

    print("\n=== with events ===")
    sql("INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
        f"VALUES ('{W}', 'Tennessee Saints Basketball Academy LLC', 'Open gym waiver', 'SITE-WAIVER-TEXT', '{'f' * 64}', 'n', 'n')")
    event("2099-07-11-open-gym", "open_gym", "clinic", "spot", "Open Gym Shoot-Around", [("6:00 PM", "18:00", 20), ("7:00 PM", "19:00", 1)])
    event("2099-07-12-scrimmage", "scrimmage", "clinic", "interest", "Saturday Scrimmage", [("Game", "18:00", 20)], day="2099-07-12")
    event("2099-07-13-open-gym", "open_gym", "clinic", "spot", "<img src=x onerror=alert(1)>", [("6:00 PM", "18:00", 20)], day="2099-07-13")
    event("2099-07-14-camp", "camp", "camp", "spot", "Draft Camp", [("Morning", "09:00", 30)], status="draft", day="2099-07-14")
    event("2099-07-15-open-gym", "open_gym", "clinic", "spot", "Unlisted Gym", [("6:00 PM", "18:00", 20)], public=0, day="2099-07-15")
    # The 7:00 PM session is full.
    sql("INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade, parent_name, "
        "parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, assumption_of_risk, "
        "medical_release, photo_release, signature, signed_at, created_at) VALUES ('2099-07-11-open-gym', '7:00 PM', 'confirmed', "
        f"'{'9' * 64}', 'Full Kid', 'full kid', '5th', 'P', 'p@example.com', 'p@example.com', '615', '', 'E', '615', 1, 1, 0, 'P', 'n', 'n')")
    sql("INSERT OR REPLACE INTO app_settings (key, value, updated_by, updated_at) "
        "VALUES ('events.featured', '2099-07-11-open-gym', 'test', 'n')")
    dom = render()
    section = dom.split('id="events"', 1)[-1].split("</section>", 1)[0] if 'id="events"' in dom else ""
    check("the Upcoming events section appears", 'id="events" hidden' not in dom and "Upcoming Events" in section)
    check("a card for each listed, open event", "Open Gym Shoot-Around" in section and "Saturday Scrimmage" in section)
    check("never a draft or an unlisted event", "Draft Camp" not in dom and "Unlisted Gym" not in section)
    check("each card has its button", "Register interest" in section and "Sign up" in section)
    check("sessions say open or full", "Open" in section and "Full (waiting list)" in section)
    check("the featured event is in the banner", 'class="event-banner show"' in dom
          and re.search(r'id="event-banner-title"[^>]*>Open Gym Shoot-Around<', dom) is not None)
    check("each open event is a choice on the form", 'value="event:2099-07-11-open-gym"' in dom
          and 'value="event:2099-07-12-scrimmage"' in dom)
    check("text from the API stays text", "&lt;img src=x onerror=alert(1)&gt;" in dom and "<img src=\"x\"" not in dom
          and "<img src=x" not in dom)

    print("\n=== a link to one event ===")
    dom = render("?event=2099-07-11-open-gym")
    form = dom.split('id="dynamic-form-fields"', 1)[-1].split("</form>", 1)[0]
    check("opens that event's form, with its fields", 'name="emergency_contact_name"' in form and 'name="signature"' in form
          and 'name="session_time"' in form, len(form))
    check("and its waiver, before anything is agreed to", "SITE-WAIVER-TEXT" in form
          and form.index("SITE-WAIVER-TEXT") < form.index('name="assumption_of_risk"')
          and f'value="{W}"' in form)
    dom = render("?event=2099-07-15-open-gym")
    check("an unlisted event opens from its link", "Unlisted Gym" in dom and 'name="emergency_contact_name"' in dom)
    dom = render("?event=2099-07-12-scrimmage")
    form = dom.split('id="dynamic-form-fields"', 1)[-1].split("</form>", 1)[0]
    check("interest asks no waiver and no medical details", "SITE-WAIVER-TEXT" not in form and 'name="medical_notes"' not in form
          and 'name="parent_email"' in form)

    print("\n=== back from paying ===")
    dom = render("?event=2099-07-11-open-gym&paid=1")
    check("Stripe's return says the payment was received", 'class="modal-overlay show"' in dom and "Payment received" in dom)
    dom = render(f"?event=2099-07-11-open-gym&pay={'a' * 64}")
    check("leaving before paying offers to pay for the held place", "Your place is still held" in dom and ">Pay now<" in dom)
finally:
    server.shutdown()

check.finish()
