"""Shared guards and helpers for the Worker test suites.

These suites are destructive. They insert registrations, cancel them, fill
sessions to capacity and clear tables. Two preconditions are enforced here as
executable checks rather than documented conventions, because both failure
modes are silent and expensive.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def require_local(base_url):
    """Refuse to run against anything but a local Worker.

    Pointed at api.tnsaints.com these suites would create dozens of real
    registrations under fabricated names, send real email from the production
    domain to addresses that do not exist, and leave the roster unusable. The
    damage would not be obvious until someone opened the CSV.
    """
    host = urlparse(base_url).hostname
    if host not in LOCAL_HOSTS:
        sys.exit(
            f"\nREFUSING TO RUN.\n"
            f"  BASE is {base_url!r} (host {host!r}).\n"
            f"  These tests mutate the database and send email. They may only\n"
            f"  run against a local `wrangler dev`. Start one with:\n"
            f"      cd worker && npm run dev\n"
        )


def require_email_disabled():
    """Refuse to run unless local outbound email is switched off.

    `.dev.vars` may legitimately hold a real Resend key so a developer can test
    a single send by hand. Left that way, one full acceptance run fires roughly
    eighty real emails and consumes the day's entire free-tier budget - which
    also means the next genuine registration silently notifies nobody.

    EMAIL_DAILY_LIMIT=0 makes reserveSend() refuse every send while leaving all
    other code paths intact.
    """
    dev_vars = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    if not os.path.exists(dev_vars):
        return  # No local secrets at all: nothing can send. Fine.

    with open(dev_vars, encoding="utf-8") as fh:
        lines = [ln.strip() for ln in fh if ln.strip() and not ln.strip().startswith("#")]

    settings = {}
    for ln in lines:
        if "=" in ln:
            k, v = ln.split("=", 1)
            settings[k.strip()] = v.strip()

    has_key = bool(settings.get("RESEND_API_KEY", "").startswith("re_"))
    disabled = settings.get("EMAIL_DAILY_LIMIT") == "0"

    if has_key and not disabled:
        sys.exit(
            "\nREFUSING TO RUN.\n"
            "  worker/.dev.vars holds a real RESEND_API_KEY and\n"
            "  EMAIL_DAILY_LIMIT is not 0.\n"
            "  A full run would send ~80 real emails and exhaust the daily\n"
            "  free-tier budget, so genuine registrations would notify nobody.\n"
            "  Add this line to worker/.dev.vars:\n"
            "      EMAIL_DAILY_LIMIT=0\n"
        )


def preflight(base_url):
    """Run every guard. Call this before the first request in a suite."""
    require_local(base_url)
    require_email_disabled()
