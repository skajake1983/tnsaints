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
    endpoint = settings.get("RESEND_ENDPOINT", "")
    local_endpoint = bool(endpoint) and urlparse(endpoint).hostname in LOCAL_HOSTS

    # A loopback endpoint is the real guard, and it is the one to check first.
    #
    # This used to key on EMAIL_DAILY_LIMIT=0, which it described as switching
    # sending off. It never did: reserveSend read the limit as
    # `parseInt(value) || 100`, and zero is falsy, so 0 meant 100. The guard was
    # inert, and anyone who pasted a real key while trusting it would have sent
    # roughly eighty real emails from the academy's domain to invented
    # addresses. The bug is fixed, but the check now rests on something that
    # cannot be undone by an arithmetic slip: if mail is pointed at localhost,
    # it physically cannot reach Resend regardless of key or budget.
    if local_endpoint:
        return

    disabled = settings.get("EMAIL_DAILY_LIMIT") == "0"

    if has_key and not disabled:
        sys.exit(
            "\nREFUSING TO RUN.\n"
            "  worker/.dev.vars holds a RESEND_API_KEY, RESEND_ENDPOINT does not\n"
            "  point at localhost, and EMAIL_DAILY_LIMIT is not 0.\n"
            "  A full run would send ~80 real emails from the academy's domain\n"
            "  to invented addresses.\n"
            "  Point sending at the local sink instead:\n"
            "      RESEND_ENDPOINT=http://127.0.0.1:8799/emails\n"
        )


def _dev_vars():
    """Parse worker/.dev.vars into a dict. Empty if the file is absent."""
    path = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    if not os.path.exists(path):
        return {}

    settings = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            settings[key.strip()] = value.strip()
    return settings


def staff_email():
    """The address the local dev bypass signs in as.

    Read from .dev.vars rather than hardcoded, for two reasons.

    The first is correctness: it has to match DEV_ADMIN_EMAIL or every admin
    test 403s, and a hardcoded copy is a second source of truth that drifts.

    The second is that this repository is PUBLIC. Hardcoding real staff
    addresses publishes exactly which mailboxes are on the Cloudflare Access
    allow-list -- which is the useful half of a targeted phishing attempt
    against accounts that can read children's medical notes. The addresses are
    not secret, and the security model does not depend on their secrecy, but
    there is no reason to hand over the target list with the source.
    """
    email = _dev_vars().get("DEV_ADMIN_EMAIL", "").strip()
    if not email:
        sys.exit(
            "\nREFUSING TO RUN.\n"
            "  DEV_ADMIN_EMAIL is not set in worker/.dev.vars, so there is no\n"
            "  identity to sign in as locally. Add it:\n"
            "      DEV_ADMIN_EMAIL=you@example.com\n"
            "  and make sure that address exists in the `staff` table.\n"
        )
    return email


def preflight(base_url):
    """Run every guard. Call this before the first request in a suite."""
    require_local(base_url)
    require_email_disabled()
