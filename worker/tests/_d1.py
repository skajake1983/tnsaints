"""Run wrangler d1 against the LOCAL database, retrying while it is busy.

Shared by reset_local_db.py and migrate_local_db.py. Only ever passes --local,
so nothing here can touch production.

Retries on SQLITE_BUSY: the dev server can still be flushing a previous suite's
writes (waitUntil work lands after the suite exits), and `wrangler d1 execute
--local` then cannot take the file lock. That flake once stopped a full,
otherwise-green baseline run.
"""
import os
import subprocess
import time

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ATTEMPTS = 6
BUSY_MARKERS = ("SQLITE_BUSY", "database is locked")


def wrangler_local(command, json_output=False):
    """A suite's SQL helper: run one --command locally, retrying while busy; returns stdout.

    Every suite used to shell out to wrangler directly with no retry. When the
    dev server was mid-write (a registration's emails reserve, fail against a
    missing sink, and refund in waitUntil), the CLI got SQLITE_BUSY and the
    suite read an empty result as "no such row" -- a lookup returning None that
    cascaded into two dozen failures in an otherwise-green run on 2026-09-26.
    """
    args = ["npx", "wrangler", "d1", "execute", "tnsaints", "--local"]
    if json_output:
        args.append("--json")
    args += ["--command", command]
    stdout = ""
    for attempt in range(1, ATTEMPTS + 1):
        result = subprocess.run(args, capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR)
        stdout = (result.stdout or b"").decode("utf-8", "replace")
        stderr = (result.stderr or b"").decode("utf-8", "replace")
        busy = any(marker in stdout + stderr for marker in BUSY_MARKERS)
        if not busy or attempt == ATTEMPTS:
            return stdout
        time.sleep(attempt * 0.5)
    return stdout


def execute_local(*, command=None, file=None):
    """Run one --command or --file. Returns (ok, attempts, combined output)."""
    args = ["npx", "wrangler", "d1", "execute", "tnsaints", "--local"]
    args += ["--command", command] if command is not None else ["--file", file]
    output = ""
    for attempt in range(1, ATTEMPTS + 1):
        result = subprocess.run(args, capture_output=True, shell=(os.name == "nt"), cwd=WORKER_DIR)
        output = (result.stdout or b"").decode("utf-8", "replace") + (result.stderr or b"").decode(
            "utf-8", "replace"
        )
        if result.returncode == 0:
            return True, attempt, output
        if any(marker in output for marker in BUSY_MARKERS) and attempt < ATTEMPTS:
            time.sleep(attempt)  # 1s, 2s, 3s ... while the dev server finishes writing
            continue
        return False, attempt, output
    return False, ATTEMPTS, output
