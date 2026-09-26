"""Bring the LOCAL D1 database up to date: schema.sql, then every migration.

`npm run db:migrate:local` runs this, and `npm run test:local` runs it first, so
a new migration can never leave the suites failing on a missing table. It only
ever passes --local.

Safe to repeat. schema.sql and most migrations are IF NOT EXISTS throughout; the
ALTER-only ones (SQLite has no ADD COLUMN IF NOT EXISTS) fail on a second run
with "duplicate column name", which means already applied and changes nothing.
Any other error stops the run.

Production is migrated by hand, one reviewed file at a time, BEFORE deploying
code that reads the new tables; see the header of each migration.
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import WORKER_DIR, execute_local


def files():
    return [os.path.join(WORKER_DIR, "schema.sql")] + sorted(
        glob.glob(os.path.join(WORKER_DIR, "migrations", "[0-9][0-9][0-9]_*.sql"))
    )


def main():
    applied = already = 0
    for path in files():
        ok, _, output = execute_local(file=path)
        if ok:
            applied += 1
        elif "duplicate column name" in output:
            already += 1
        else:
            sys.stderr.write(output[-2000:])
            sys.stderr.write(f"\nlocal migrate FAILED at {os.path.basename(path)}\n")
            return 1
    print(f"local DB migrated: {applied + already} files ({already} ALTER-only, already applied)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
