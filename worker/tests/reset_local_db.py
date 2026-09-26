"""Reset the LOCAL D1 database between test suites.

`npm run db:reset:local` runs this. It only ever passes --local, so it cannot
touch production.

Why a script instead of one long wrangler command in package.json:

1. It retries on SQLITE_BUSY (tests/_d1.py). The dev server can still be
   flushing a previous suite's writes when the reset starts -- the concurrency
   suite fires a burst of simultaneous registrations whose waitUntil() work
   lands after the suite exits. That flake stopped a full baseline run on
   2026-09-26 with every suite up to that point green.

2. The table list lives in one readable place. Tables are deleted CHILDREN
   FIRST because foreign keys are enforced. When a migration adds a table, add
   it here in dependency order.

3. Seeds come back. Migrations that seed rows (the academy draft program, the
   CRM pipeline stages) are re-applied after the delete; they are idempotent.

`staff` and `audit_log` are deliberately not reset: suites seed and inspect
them themselves. `crm_stages` is seed data only and is never deleted.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import WORKER_DIR, execute_local

# Children before parents.
TABLES = [
    # CRM intake (012)
    "crm_tasks",
    "crm_opportunities",
    "crm_inquiries",
    "crm_prospect_players",
    "crm_contacts",
    # Billing (010)
    "payments",
    "paypal_events",
    "billing_subscriptions",
    # Programs and enrollment (009)
    "enrollments",
    "consent_records",
    "program_groups",
    "programs",
    "waiver_versions",
    # Children's medical (007)
    "player_medical",
    # Evaluation pipeline (schema.sql, 002)
    "parent_feedback",
    "parent_messages",
    "decisions",
    "decision_batches",
    "eval_notes_internal",
    "eval_feedback",
    "registrations",
    "players",
    # Households and sign-in (007)
    "household_emergency_contacts",
    "household_invites",
    "household_members",
    "sessions",
    "auth_login_tokens",
    "auth_oidc_flows",
    "rate_limits",
    "account_identities",
    "households",
    "accounts",
    "data_requests",
    # Platform (011)
    "job_runs",
    "app_settings",
    "email_budget",
]

# Re-applied after the delete to restore their seed rows.
SEED_MIGRATIONS = ["009_programs_enrollment.sql", "012_crm_intake.sql"]


def main():
    command = " ".join(f"DELETE FROM {t};" for t in TABLES)
    ok, attempt, output = execute_local(command=command)
    if not ok:
        sys.stderr.write(output[-2000:])
        sys.stderr.write(
            f"\nlocal DB reset FAILED (attempt {attempt}). If a table is missing, run: npm run db:migrate:local\n"
        )
        return 1

    for name in SEED_MIGRATIONS:
        seeded, _, output = execute_local(file=os.path.join(WORKER_DIR, "migrations", name))
        if not seeded:
            sys.stderr.write(output[-2000:])
            sys.stderr.write(f"\nlocal DB reset: re-seeding {name} FAILED\n")
            return 1

    print(f"local DB reset: {len(TABLES)} tables cleared, seeds restored"
          + (f" (attempt {attempt})" if attempt > 1 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
