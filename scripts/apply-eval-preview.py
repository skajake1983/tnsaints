#!/usr/bin/env python3
"""Apply the date-appropriate shareable-link preview to index.html.

The site is GitHub Pages (static, no server-side compute), so the Open Graph /
Twitter tags a social crawler reads have to physically be in the served HTML.
This script — run hourly by .github/workflows/eval-preview.yml — keeps those
tags correct for the current date, reading eval-preview.json:

  * EVERGREEN (academy, no dates) shows by default.
  * The EVAL preview shows only while eval.activeUntil is in the future; the
    first run after that timestamp reverts to evergreen.
  * Otherwise, the FEATURED EVENT from the academy's live events API
    (https://api.tnsaints.com/api/events: the event in the website banner,
    Admin -> Events -> "Put in the website banner") shows while it is open for
    sign-ups. Its own preview image if it has one, the evergreen image if not.
  * Otherwise, an EVALUATION PROGRAM from the academy's live programs API
    (https://api.tnsaints.com/api/programs) shows while its sign-up is open, if
    staff gave it a preview image (Admin -> Programs). So the next evaluation's
    card can come from the admin, with no edit here. If the API cannot be
    reached, this behaves exactly as before.

It is idempotent: it rewrites index.html only when a tag actually differs, so
the workflow commits only when the preview genuinely needs to flip (at most
about twice per eval — apply on launch, revert on expiry).

    python scripts/apply-eval-preview.py            # apply + write
    python scripts/apply-eval-preview.py --check     # exit 1 if it WOULD change
"""
import datetime
import html as html_lib
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROGRAMS_API = "https://api.tnsaints.com/api/programs"
EVENTS_API = "https://api.tnsaints.com/api/events"
CONFIG = ROOT / "eval-preview.json"
INDEX = ROOT / "index.html"

# (meta attribute, its value) -> which preview field fills the content="".
TAGS = [
    ("property", "og:title", "title"),
    ("name", "twitter:title", "title"),
    ("property", "og:description", "description"),
    ("name", "twitter:description", "description"),
    ("property", "og:image", "image"),
    ("name", "twitter:image", "image"),
    ("property", "og:image:alt", "alt"),
    ("name", "twitter:image:alt", "alt"),
]


def eval_is_active(cfg, now):
    ev = cfg.get("eval") or {}
    raw = ev.get("activeUntil")
    if not raw:
        return False
    try:
        until = datetime.datetime.fromisoformat(raw)
    except ValueError:
        # A malformed date fails safe to evergreen rather than guessing.
        print(f"WARNING: eval.activeUntil is unparseable ({raw!r}); using evergreen")
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=datetime.timezone.utc)
    return now <= until


def program_preview(now):
    """An open evaluation program with a preview card, from the live API, or None."""
    if "--no-api" in sys.argv:
        return None
    try:
        req = urllib.request.Request(PROGRAMS_API, headers={"Accept": "application/json", "User-Agent": "tnsaints-link-preview"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as exc:  # network, HTTP or JSON: fall back, never fail the job
        print(f"NOTE: programs API unavailable ({exc.__class__.__name__}); using eval-preview.json only")
        return None
    for p in data.get("programs") or []:
        image = str(p.get("preview_image") or "")
        if p.get("kind") != "evaluation" or not image.startswith("https://"):
            continue
        try:
            until = datetime.datetime.fromisoformat(str(p.get("registration_closes_at") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if until.tzinfo is None:
            until = until.replace(tzinfo=datetime.timezone.utc)
        if now > until:
            continue
        title = str(p.get("preview_title") or p.get("name") or "")[:120]
        # Text from the API goes into an HTML attribute: escape it.
        return {
            "title": html_lib.escape(title, quote=True),
            "description": html_lib.escape(str(p.get("description") or "")[:300], quote=True),
            "image": html_lib.escape(image, quote=True),
            "alt": html_lib.escape(title, quote=True),
        }
    return None


def event_preview(cfg):
    """The featured event, open for sign-ups, from the live events API, or None."""
    if "--no-api" in sys.argv:
        return None
    try:
        req = urllib.request.Request(EVENTS_API, headers={"Accept": "application/json", "User-Agent": "tnsaints-link-preview"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as exc:  # network, HTTP or JSON: fall back, never fail the job
        print(f"NOTE: events API unavailable ({exc.__class__.__name__})")
        return None
    featured = data.get("featured")
    for e in data.get("events") or []:
        if e.get("id") != featured or not e.get("registration_open"):
            continue
        banner = e.get("banner") or {}
        title = f"{banner.get('title') or e.get('name') or ''} | Tennessee Saints"[:120]
        description = str(banner.get("text") or e.get("description") or "")[:300]
        image = str(e.get("image") or "")
        if not image.startswith("https://"):
            image = cfg["evergreen"]["image"]
        # Text from the API goes into an HTML attribute: escape it.
        return {
            "title": html_lib.escape(title, quote=True),
            "description": html_lib.escape(description, quote=True),
            "image": html_lib.escape(image, quote=True),
            "alt": html_lib.escape(title, quote=True),
        }
    return None


def set_meta(html, attr, value, content):
    # Target the tag by its property/name, replacing whatever content it holds,
    # so the current dash encodings never have to be matched by hand.
    pattern = re.compile(r'(<meta ' + attr + r'="' + re.escape(value) + r'"\s+content=")[^"]*(")')
    new_html, n = pattern.subn(lambda m: m.group(1) + content + m.group(2), html)
    if n != 1:
        raise SystemExit(f"ERROR: expected exactly one <meta {attr}=\"{value}\">, found {n}")
    return new_html


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    now = datetime.datetime.now(datetime.timezone.utc)
    active = eval_is_active(cfg, now)
    from_event = None if active else event_preview(cfg)
    from_api = None if active or from_event else program_preview(now)
    mode = "eval" if active else "event" if from_event else "program" if from_api else "evergreen"
    chosen = cfg["eval"] if active else from_event or from_api or cfg["evergreen"]

    # newline="" preserves the file's existing line endings byte-for-byte; only
    # the tag content changes.
    with open(INDEX, encoding="utf-8", newline="") as fh:
        original = fh.read()

    html = original
    for attr, value, field in TAGS:
        html = set_meta(html, attr, value, chosen[field])

    changed = html != original
    if "--check" in sys.argv:
        print(f"mode={mode} changed={changed}")
        sys.exit(1 if changed else 0)

    if changed:
        with open(INDEX, "w", encoding="utf-8", newline="") as fh:
            fh.write(html)
    print(f"mode={mode} changed={changed}")


if __name__ == "__main__":
    main()
