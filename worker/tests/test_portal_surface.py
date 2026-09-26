"""The parent portal surface: routing, the closed-by-default switch, headers, shell.

Locally the portal is reached through the /__portal door, which opens only when
.dev.vars sets DEV_PORTAL=true and the request carries no Cf-Ray header (i.e.
did not come through Cloudflare's edge). Production reaches it by hostname
(PORTAL_HOSTNAME); that routing, and the maintenance switch, are tested by
importing the modules directly, since one dev server has one configuration.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import preflight, _dev_vars

BASE = "http://127.0.0.1:8787"
preflight(BASE)

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTAL = "/__portal"

settings = _dev_vars()
if settings.get("DEV_PORTAL") != "true" or settings.get("PORTAL_ENABLED") != "true":
    sys.exit("\nREFUSING TO RUN.\n  The local portal door is closed. Add to worker/.dev.vars and restart `npm run dev`:\n"
             "      DEV_PORTAL=true\n      PORTAL_ENABLED=true\n")

passed, failed = [], []

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    if cond or not detail:
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    else:
        print(f"  FAIL  {label}   {str(detail).encode('ascii', 'replace').decode('ascii')[:300]}")


def get(path, method="GET", headers=None, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=body)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


EXPECTED_CSP = ("default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; "
                "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")

print("\n=== the front door ===")
st, h, body = get(PORTAL + "/")
html = body.decode("utf-8", "replace")
check("GET /__portal/ answers 200", st == 200, st)
check("it is the parent portal shell", "Parent Portal" in html and "<h1>" in html, html[:200])
scripts = re.findall(r"<script[^>]*>", html, re.I)
check("its only script is the Turnstile loader; nothing inline",
      scripts == ['<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>'], scripts)
check("lang, skip link and a main landmark are present",
      '<html lang="en">' in html and 'class="skip" href="#main"' in html and '<main id="main"' in html)
check("links are built under the local door, so they work locally",
      'href="/__portal/"' in html and 'src="/__portal/logo.png"' in html, re.findall(r'(?:href|src)="[^"]*"', html)[:6])
st2, _, _ = get(PORTAL)
check("the door without a trailing slash is the same page", st2 == 200, st2)

print("\n=== headers ===")
hl = {k.lower(): v for k, v in h.items()}
_, h404, body404 = get(PORTAL + "/no-such-page")
csp404 = {k.lower(): v for k, v in h404.items()}.get("content-security-policy")
check("an ordinary portal page allows no script and no framing", csp404 == EXPECTED_CSP, csp404)
check("and carries no script", b"<script" not in body404.lower())
check("HSTS", "max-age=31536000" in hl.get("strict-transport-security", ""))
check("never cached", "no-store" in hl.get("cache-control", ""))
check("no camera, microphone, location or payment API",
      all(f"{p}=()" in hl.get("permissions-policy", "") for p in ("camera", "microphone", "geolocation", "payment")),
      hl.get("permissions-policy"))
check("cross-origin opener isolated", hl.get("cross-origin-opener-policy") == "same-origin")
check("kept out of search indexes", "noindex" in hl.get("x-robots-tag", ""))
check("not frameable, not sniffable, no referrer",
      hl.get("x-frame-options") == "DENY" and hl.get("x-content-type-options") == "nosniff"
      and hl.get("referrer-policy") == "no-referrer")

print("\n=== everything else ===")
st, h, body = get(PORTAL + "/logo.png")
check("the logo is served", st == 200 and h.get("Content-Type", h.get("content-type", "")).startswith("image/png"), st)
st, h, body = get(PORTAL + "/family/123")
check("an unknown page is a 404 portal page", st == 404 and b"couldn't find" in body, st)
st, _, body = get(PORTAL + "/", method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"}, body=b"x=1")
check("a POST with no origin evidence is refused before any route", st == 403, st)
st, _, body = get(PORTAL + "/", method="POST", body=b"x=1", headers={
    "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin"})
check("a same-origin POST to a page with no form handler is a 404", st == 404, st)

print("\n=== the local door stays shut when it should ===")
st, h, body = get(PORTAL + "/", headers={"Cf-Ray": "8c0ffee0000000-DFW"})
check("a request that came through Cloudflare's edge never enters the dev door",
      st == 404 and b"Parent Portal" not in body, f"{st} {body[:120]}")
st, _, body = get("/__portalx")
check("a look-alike prefix is not the portal", st == 404 and b"Parent Portal" not in body, st)

print("\n=== the other surfaces are untouched ===")
st, _, _ = get("/__admin/")
check("the admin still answers", st == 200, st)
st, _, body = get("/api/health")
check("the public API still answers", st == 200 and b'"ok":true' in body.replace(b" ", b""), body[:80])

print("\n=== routing and the switch (modules imported directly) ===")
UNIT = r"""
import { resolveSurface } from './src/index.js';
import { handlePortal } from './src/portal/router.js';
import { field, errorSummary } from './src/portal/ui.js';
const r = (url, headers = {}) => new Request(url, { headers });
const S = (url, env, headers) => { const s = resolveSurface(r(url, headers), env); return [s.surface, s.path, s.base ?? null]; };
const prod = { ADMIN_HOSTNAME: 'admin.tnsaints.com', PORTAL_HOSTNAME: 'portal.tnsaints.com' };
const dev = { ...prod, DEV_ADMIN_EMAIL: 'x@example.com', DEV_PORTAL: 'true' };
const ctx = { waitUntil() {} };
const status = async (env, path = '/') =>
  (await handlePortal(r('https://portal.tnsaints.com' + path), env, ctx, { path, base: '' })).status;
const off = await handlePortal(r('https://portal.tnsaints.com/'), {}, ctx, { path: '/', base: '' });
console.log(JSON.stringify({
  routes: {
    admin: S('https://admin.tnsaints.com/users', prod),
    portal: S('https://portal.tnsaints.com/family', prod),
    api: S('https://api.tnsaints.com/api/health', prod),
    portal_host_unconfigured: S('https://portal.tnsaints.com/', { ADMIN_HOSTNAME: 'admin.tnsaints.com' }),
    dev_portal: S('http://api.tnsaints.com/__portal/family', dev),
    dev_portal_root: S('http://api.tnsaints.com/__portal', dev),
    dev_portal_edge: S('http://api.tnsaints.com/__portal/family', dev, { 'Cf-Ray': 'abc' }),
    dev_portal_off: S('http://api.tnsaints.com/__portal/family', { ...prod, DEV_PORTAL: 'false' }),
    dev_portal_typo: S('http://api.tnsaints.com/__portal/family', { ...prod, DEV_PORTAL: 'True' }),
    dev_lookalike: S('http://api.tnsaints.com/__portalx', dev),
    dev_admin: S('http://api.tnsaints.com/__admin/users', dev),
  },
  switch: {
    unset: await status({}), off: await status({ PORTAL_ENABLED: 'false' }),
    typo: await status({ PORTAL_ENABLED: 'TRUE' }),
    on: await status({ PORTAL_ENABLED: 'true', AUTH_PEPPER: 'p'.repeat(40) }),
    on_without_pepper: await status({ PORTAL_ENABLED: 'true' }),
    logo_while_off: await status({}, '/logo.png'),
    retry_after: off.headers.get('Retry-After'),
    off_body_mentions_open: (await off.text()).includes("isn't open"),
  },
  escaping: field({ id: 'email', label: 'Email', value: '"><script>alert(1)</script>', error: '<b>bad</b>' })
    + errorSummary([{ id: 'x" onmouseover="y', message: '<img src=x>' }]),
}));
"""
res = subprocess.run(["node", "--input-type=module", "-e", UNIT], capture_output=True, cwd=WORKER_DIR)
try:
    u = json.loads((res.stdout or b"").decode().strip().splitlines()[-1])
except Exception:
    u = None
check("unit harness ran", u is not None, (res.stderr or b"").decode()[-400:])
if u:
    rt = u["routes"]
    check("admin host -> admin", rt["admin"] == ["admin", "/users", ""], rt["admin"])
    check("portal host -> portal, no prefix", rt["portal"] == ["portal", "/family", ""], rt["portal"])
    check("api host -> api", rt["api"][0] == "api", rt["api"])
    check("with PORTAL_HOSTNAME unset, the portal host is not the portal", rt["portal_host_unconfigured"][0] == "api",
          rt["portal_host_unconfigured"])
    check("dev door -> portal with the prefix stripped and remembered",
          rt["dev_portal"] == ["portal", "/family", "/__portal"], rt["dev_portal"])
    check("dev door root -> '/'", rt["dev_portal_root"] == ["portal", "/", "/__portal"], rt["dev_portal_root"])
    check("dev door refuses anything that came through the edge", rt["dev_portal_edge"][0] == "api", rt["dev_portal_edge"])
    check("dev door shut when DEV_PORTAL is not exactly 'true'",
          rt["dev_portal_off"][0] == "api" and rt["dev_portal_typo"][0] == "api")
    check("a look-alike prefix is not the door", rt["dev_lookalike"][0] == "api", rt["dev_lookalike"])
    check("the admin dev door is unchanged", rt["dev_admin"][:2] == ["admin", "/users"], rt["dev_admin"])
    sw = u["switch"]
    check("PORTAL_ENABLED unset -> 503 maintenance", sw["unset"] == 503, sw)
    check("'false' -> 503", sw["off"] == 503, sw)
    check("a misspelling ('TRUE') stays closed", sw["typo"] == 503, sw)
    check("exactly 'true' -> open", sw["on"] == 200, sw)
    check("switched on but with no AUTH_PEPPER it stays closed", sw["on_without_pepper"] == 503, sw)
    check("the maintenance page still gets its logo", sw["logo_while_off"] == 200, sw)
    check("maintenance says come back later (Retry-After, plain words)",
          sw["retry_after"] == "3600" and sw["off_body_mentions_open"], sw)
    esc_html = u["escaping"]
    check("form helpers escape values, errors and ids",
          "<script>" not in esc_html and "<b>" not in esc_html and "<img" not in esc_html
          and 'x" onmouseover' not in esc_html, esc_html[:300])

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
sys.exit(1 if failed else 0)
