"""Reset the LOCAL D1 database between test suites.

`npm run db:reset:local` runs this. It only ever passes --local, so it cannot
touch production.

Why a script instead of one long wrangler command in package.json:

1. It retries on SQLITE_BUSY. The dev server can still be flushing a previous
   suite's writes when the reset starts -- the concurrency suite fires a burst of
   simultaneous registrations whose waitUntil() work lands after the suite
   exits -- and `wrangler d1 execute --local` then cannot take the file lock.
   That flake stopped a full baseline run on 2026-09-26 with every suite up to
   that point green.

2. The table list lives in one readable place. Tables are deleted CHILDREN
   FIRST because foreign keys are enforced. When a migration adds a table, add
   it here in dependency order.

`staff` and `audit_log` are deliberately not reset: suites seed and inspect
them themselves.
"""
import os
import subprocess
import sys
import time

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Children before parents.
TABLES = [
    "parent_feedback",
    "parent_messages",
    "decisions",
    "decision_batches",
    "eval_notes_internal",
    "eval_feedback",
    "registrations",
    "players",
    "email_budget",
]

ATTEMPTS = 6
BUSY_MARKERS = ("SQLITE_BUSY", "database is locked")


def main():
    command = " ".join(f"DELETE FROM {t};" for t in TABLES)
    for attempt in range(1, ATTEMPTS + 1):
        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "tnsaints", "--local", "--command", command],
            capture_output=True,
            shell=(os.name == "nt"),
            cwd=WORKER_DIR,
        )
        output = (result.stdout or b"").decode("utf-8", "replace") + (result.stderr or b"").decode(
            "utf-8", "replace"
        )
        if result.returncode == 0:
            print(f"local DB reset: {len(TABLES)} tables cleared"
                  + (f" (attempt {attempt})" if attempt > 1 else ""))
            return 0
        if any(marker in output for marker in BUSY_MARKERS) and attempt < ATTEMPTS:
            time.sleep(attempt)  # 1s, 2s, 3s ... while the dev server finishes writing
            continue
        sys.stderr.write(output[-2000:])
        sys.stderr.write(f"\nlocal DB reset FAILED (attempt {attempt}, exit {result.returncode})\n")
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
