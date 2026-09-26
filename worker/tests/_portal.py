"""Shared helpers for the parent portal suites.

Requests go to the local portal door (/__portal) without following redirects,
so every Set-Cookie and Location can be inspected. Sessions can be minted
directly for suites that are not about signing in: the helper computes the same
HMAC the Worker does, from the local AUTH_PEPPER in .dev.vars, which never
leaves this machine.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import wrangler_local
from _harness import _dev_vars

BASE = "http://127.0.0.1:8787"
P = "/__portal"
WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAME_ORIGIN = {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8787"}
NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def require_portal():
    settings = _dev_vars()
    for key, want in (("DEV_PORTAL", "true"), ("PORTAL_ENABLED", "true")):
        if settings.get(key) != want:
            sys.exit(f"\nREFUSING TO RUN.\n  worker/.dev.vars needs {key}={want}\n")
    if len(settings.get("AUTH_PEPPER", "")) < 32:
        sys.exit("\nREFUSING TO RUN.\n  worker/.dev.vars needs AUTH_PEPPER (32+ random characters).\n")
    return settings


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def sql(command):
    """Run SQL against the local D1 and return the result rows."""
    try:
        return json.loads(wrangler_local(command, json_output=True))[0]["results"]
    except Exception:
        return []


def request(method, path, fields=None, cookies=None, headers=None, ip="10.50.0.1", content_type=None):
    """Returns (status, headers dict, [Set-Cookie values], body text)."""
    data = urllib.parse.urlencode(fields, doseq=True).encode() if fields is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", content_type or "application/x-www-form-urlencoded")
    req.add_header("CF-Connecting-IP", ip)
    if cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = _OPENER.open(req)
    except urllib.error.HTTPError as e:
        r = e
    body = r.read().decode("utf-8", "replace")
    return getattr(r, "status", None) or r.code, dict(r.headers), r.headers.get_all("Set-Cookie") or [], body


def get(path, cookies=None, headers=None, ip="10.50.0.1"):
    return request("GET", path, None, cookies, headers, ip)


def post(path, fields, cookies=None, headers=None, ip="10.50.0.1"):
    """A form post the way a portal page makes it: same-origin."""
    return request("POST", path, fields, cookies, {**SAME_ORIGIN, **(headers or {})}, ip)


def cookie_value(set_cookies, name):
    for c in set_cookies:
        if c.startswith(name + "="):
            return c.split(";", 1)[0].split("=", 1)[1]
    return None


def cookie_line(set_cookies, name):
    return next((c for c in set_cookies if c.startswith(name + "=")), "")


def b64url(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def keyed_hash(purpose, value):
    """The Worker's keyedHash(): HMAC-SHA256(AUTH_PEPPER, purpose || 0x00 || value), base64url."""
    pepper = _dev_vars()["AUTH_PEPPER"].encode()
    return b64url(hmac.new(pepper, purpose.encode() + b"\x00" + value.encode(), hashlib.sha256).digest())


def make_account(email, status="active", name=None):
    norm = email.strip().lower()
    sql(f"INSERT INTO accounts (email, email_norm, display_name, status, created_at, updated_at) VALUES "
        f"('{email}', '{norm}', {repr(name) if name else 'NULL'}, '{status}', {NOW_SQL}, {NOW_SQL})")
    rows = sql(f"SELECT id FROM accounts WHERE email_norm='{norm}'")
    return rows[0]["id"] if rows else None


def mint_session(account_id, recent=True):
    """A live session for `account_id`; returns the cookie value. `recent` sets auth_at to now."""
    sid = b64url(secrets.token_bytes(32))
    auth_at = NOW_SQL if recent else "'2000-01-01T00:00:00.000Z'"
    sql("INSERT INTO sessions (id_hash, account_id, auth_method, auth_at, created_at, last_seen_at, "
        "idle_expires_at, absolute_expires_at) VALUES "
        f"('{keyed_hash('session', sid)}', {account_id}, 'email', {auth_at}, {NOW_SQL}, {NOW_SQL}, "
        "'2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')")
    return sid


def session_cookies(sid):
    return {"__Host-tns_session": sid}


class Checker:
    def __init__(self):
        self.passed, self.failed = [], []
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    def __call__(self, label, cond, detail=""):
        (self.passed if cond else self.failed).append(label)
        if cond or not detail:
            print(f"  {'PASS' if cond else 'FAIL'}  {label}")
        else:
            print(f"  FAIL  {label}   {str(detail).encode('ascii', 'replace').decode('ascii')[:300]}")

    def finish(self):
        print("\n" + "=" * 62)
        print(f"PASSED: {len(self.passed)}    FAILED: {len(self.failed)}")
        if self.failed:
            print("\nFailures:")
            for f in self.failed:
                print("  - " + f)
        print("=" * 62)
        sys.exit(1 if self.failed else 0)
