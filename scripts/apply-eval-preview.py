#!/usr/bin/env python3
"""Apply the date-appropriate shareable-link preview to index.html.

The site is GitHub Pages (static, no server-side compute), so the Open Graph /
Twitter tags a social crawler reads have to physically be in the served HTML.
This script — run hourly by .github/workflows/eval-preview.yml — keeps those
tags correct for the current date, reading eval-preview.json:

  * EVERGREEN (academy, no dates) shows by default.
  * The EVAL preview shows only while eval.activeUntil is in the future; the
    first run after that timestamp reverts to evergreen.

It is idempotent: it rewrites index.html only when a tag actually differs, so
the workflow commits only when the preview genuinely needs to flip (at most
about twice per eval — apply on launch, revert on expiry).

    python scripts/apply-eval-preview.py            # apply + write
    python scripts/apply-eval-preview.py --check     # exit 1 if it WOULD change
"""
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
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
    mode = "eval" if active else "evergreen"
    chosen = cfg["eval"] if active else cfg["evergreen"]

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
