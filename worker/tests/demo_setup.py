"""A clean local copy to try things by hand (not a test).

    python tests/demo_setup.py

Resets the local database (as the suites do), then adds what a real
production database has, so the admin and the website behave as they will
live:
- you, as an academy admin (DEV_ADMIN_EMAIL from .dev.vars, which signs you
  in locally);
- the 8/29 evaluation as a past event (migration 022);
- the approved event waiver and tournament team agreement
  (seeds/events-waivers-2026-10.sql).

Local only: it refuses to touch anything but the local database. Emails the
local Worker sends go to tests/mail_viewer.py, never to anyone.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import execute_local
from _harness import staff_email

WORKER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_file(rel):
    ok, _, out = execute_local(file=os.path.join(WORKER, rel))
    if not ok:
        sys.exit(f"{rel} failed:\n{out[-800:]}")
    print(f"  applied {rel}")


def main():
    me = staff_email()
    if subprocess.run([sys.executable, os.path.join(WORKER, "tests", "reset_local_db.py")]).returncode:
        sys.exit("the local reset failed")
    run_file("migrations/022_events_past_evaluation.sql")
    run_file("seeds/events-waivers-2026-10.sql")
    ok, _, out = execute_local(command=(
        "DELETE FROM staff; INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at) "
        f"VALUES ('{me.lower()}', 'Local Admin', 'Coach', 'admin', 1, datetime('now'), datetime('now'));"))
    if not ok:
        sys.exit(f"adding you as staff failed:\n{out[-800:]}")
    print("  you are an academy admin locally")
    print("\nReady. Admin: http://127.0.0.1:8787/__admin/events")


if __name__ == "__main__":
    main()
