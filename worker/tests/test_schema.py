"""The schema's own guarantees (schema.sql + migrations/*.sql).

Builds a fresh database in memory from the same files production is built
from, in the documented order, then proves each rule the portal relies on is
enforced by the database itself, not only by application code:

  - a waiver version can never be edited; a consent can never be altered and
    cannot be recorded against words that were never shown
  - a program cannot open without a price, a PayPal plan and a waiver
  - one live enrollment per child per program; an offer names a group
  - one live PayPal subscription per enrollment
  - a medical answer is either "nothing to declare" or actual notes
  - pipeline cards can only sit on stages that exist
  - migrations re-run safely

Pure SQLite (Python's bundled engine, with foreign keys on as D1 has them).
Needs no Worker and sends nothing. The same files are also applied to the
local D1 by the migration step, which is what proves D1 accepts them.
"""
import glob
import hashlib
import os
import sqlite3
import sys

WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
        print(f"  FAIL  {label}   {detail}")


def migrations():
    return sorted(glob.glob(os.path.join(WORKER_DIR, "migrations", "[0-9][0-9][0-9]_*.sql")))


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def build():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(read(os.path.join(WORKER_DIR, "schema.sql")))
    for path in migrations():
        try:
            db.executescript(read(path))
        except sqlite3.OperationalError as exc:
            # A fresh database already has columns that ALTER-only migrations
            # add to old ones (schema.sql carries staff.first_seen_at). That
            # is the documented, harmless outcome; anything else is a failure.
            if "duplicate column name" not in str(exc):
                raise
    return db


def refused(db, sql, params=()):
    """True if the statement is rejected. The savepoint keeps one refusal from poisoning the next check."""
    db.execute("SAVEPOINT probe")
    try:
        db.execute(sql, params)
    except (sqlite3.IntegrityError, sqlite3.OperationalError):
        db.execute("ROLLBACK TO probe")
        db.execute("RELEASE probe")
        return True
    db.execute("ROLLBACK TO probe")
    db.execute("RELEASE probe")
    return False


def accepted(db, sql, params=()):
    return not refused(db, sql, params)


NOW = "2026-09-26T12:00:00.000Z"

print("\n=== building from schema.sql + every migration, in order ===")
names = [os.path.basename(p) for p in migrations()]
check("migrations are numbered without gaps from 001",
      [n[:3] for n in names] == [f"{i:03d}" for i in range(1, len(names) + 1)], names)
try:
    db = build()
    check("a fresh database builds", True)
except Exception as exc:  # noqa: BLE001
    check("a fresh database builds", False, exc)
    print(f"\nPASSED: {len(passed)}    FAILED: {len(failed)}")
    sys.exit(1)

print("\n=== re-running is safe ===")
for path in migrations():
    name = os.path.basename(path)
    try:
        db.executescript(read(path))
        ok = True
    except sqlite3.OperationalError as exc:
        ok = "duplicate column name" in str(exc)
    check(f"{name} re-runs without damage", ok)
fk = db.execute("PRAGMA foreign_key_check").fetchall()
check("no dangling foreign keys after the build", fk == [], fk)

print("\n=== seeds ===")
academy = db.execute("SELECT status, enrollment_mode, billing, price_cents, setup_fee_cents, "
                     "paypal_plan_id_live, grade_min, grade_max FROM programs WHERE id='academy'").fetchone()
check("the academy is seeded as a draft approval-mode subscription",
      academy is not None and academy[:3] == ("draft", "approval", "subscription"), academy)
check("with the $40 setup fee and the live plan from join.html, grades 3-6, and NO price yet",
      academy is not None and academy[3:] == (None, 4000, "P-3A8355760P817903NNKZ4ZGQ", 3, 6), academy)
stages = db.execute("SELECT pipeline, COUNT(*), SUM(outcome = 'won') FROM crm_stages GROUP BY pipeline").fetchall()
check("five pipelines, each with exactly one winning stage",
      len(stages) == 5 and all(won == 1 for _, _, won in stages), stages)

# --- fixtures ---------------------------------------------------------------
db.execute("INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES ('Mom@Example.com', 'mom@example.com', ?, ?)", (NOW, NOW))
ACC = db.execute("SELECT id FROM accounts").fetchone()[0]
db.execute("INSERT INTO households (display_name, created_at, updated_at) VALUES ('Test family', ?, ?)", (NOW, NOW))
HH = db.execute("SELECT id FROM households").fetchone()[0]
db.execute("INSERT INTO household_members (household_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)", (HH, ACC, NOW))
db.execute("INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at, household_id) "
           "VALUES ('Kid One', 'kid one', 'mom@example.com', ?, ?, ?)", (NOW, NOW, HH))
KID = db.execute("SELECT id FROM players").fetchone()[0]
WAIVER = "I understand basketball involves risk..."
SHA = hashlib.sha256(WAIVER.encode()).hexdigest()
db.execute("INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
           "VALUES ('academy-v1', 'Tennessee Saints LLC', 'Academy waiver', ?, ?, ?, ?)", (WAIVER, SHA, NOW, NOW))
db.execute("INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at) "
           "VALUES ('academy', 'Group A', 'Tuesdays 6:00-7:30 PM', 10, ?, ?)", (NOW, NOW))
GROUP = db.execute("SELECT id FROM program_groups").fetchone()[0]

print("\n=== accounts and households ===")
check("one account per email", refused(db,
      "INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES ('x', 'mom@example.com', ?, ?)", (NOW, NOW)))
check("membership requires a real account", refused(db,
      "INSERT INTO household_members (household_id, account_id, role, created_at) VALUES (?, 999, 'guardian', ?)", (HH, NOW)))
check("membership roles are fixed", refused(db,
      "INSERT INTO household_members (household_id, account_id, role, created_at) VALUES (?, ?, 'admin', ?)", (HH, ACC, NOW)))
check("at most three emergency contacts, one per priority",
      refused(db, "INSERT INTO household_emergency_contacts (household_id, priority, name, phone, created_at, updated_at) "
                  "VALUES (?, 4, 'EC', '615', ?, ?)", (HH, NOW, NOW)))

print("\n=== players ===")
check("one child of a name per family", refused(db,
      "INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at, household_id) "
      "VALUES ('Kid One', 'kid one', 'dad@example.com', ?, ?, ?)", (NOW, NOW, HH)))
check("legacy players without a household are unaffected by that rule", accepted(db,
      "INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at) "
      "VALUES ('Kid One', 'kid one', 'other@example.com', ?, ?)", (NOW, NOW)))
check("an unknown shirt size is refused", refused(db, "UPDATE players SET shirt_size='XXXL' WHERE id=?", (KID,)))
check("a real shirt size is accepted", accepted(db, "UPDATE players SET shirt_size='YM' WHERE id=?", (KID,)))
check("grade 13 is refused", refused(db, "UPDATE players SET grade_level=13 WHERE id=?", (KID,)))

print("\n=== medical ===")
MED = "INSERT INTO player_medical (player_id, status, notes, updated_by, updated_at, confirmed_at) VALUES (?, ?, ?, 'account:1', ?, ?)"
check("'declared' with blank notes is refused", refused(db, MED, (KID, "declared", "   ", NOW, NOW)))
check("'none_declared' with notes is refused", refused(db, MED, (KID, "none_declared", "peanuts", NOW, NOW)))
check("'none_declared' alone is a valid answer", accepted(db, MED, (KID, "none_declared", None, NOW, NOW)))
check("'declared' with notes is a valid answer", accepted(db, MED, (KID, "declared", "Peanut allergy", NOW, NOW)))

print("\n=== waivers and consents ===")
check("a waiver version cannot be edited", refused(db, "UPDATE waiver_versions SET body_text='new words' WHERE id='academy-v1'"))
check("a waiver hash must be 64 hex characters", refused(db,
      "INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
      "VALUES ('bad', 'x', 'x', 'x', 'abc', ?, ?)", (NOW, NOW)))
CONSENT = ("INSERT INTO consent_records (player_id, household_id, account_id, program_id, waiver_version_id, "
           "waiver_sha256, signature, signer_relationship, esign_consent, assumption_of_risk, medical_release, "
           "photo_release, signed_at) VALUES (?, ?, ?, 'academy', 'academy-v1', ?, ?, 'mother', ?, 1, 1, ?, ?)")
check("a consent against the exact waiver text is recorded", accepted(db, CONSENT, (KID, HH, ACC, SHA, "Jane Parent", 1, 0, NOW)))
check("a consent whose hash does not match the text is refused",
      refused(db, CONSENT, (KID, HH, ACC, "0" * 64, "Jane Parent", 1, 1, NOW)))
check("a consent without e-sign agreement cannot exist", refused(db, CONSENT, (KID, HH, ACC, SHA, "Jane Parent", 0, 1, NOW)))
check("a blank signature is refused", refused(db, CONSENT, (KID, HH, ACC, SHA, "  ", 1, 1, NOW)))
db.execute(CONSENT, (KID, HH, ACC, SHA, "Jane Parent", 1, 0, NOW))
check("a signed consent can never be altered", refused(db, "UPDATE consent_records SET photo_release=1"))

print("\n=== programs ===")
check("the academy cannot open without a price", refused(db,
      "UPDATE programs SET status='open', waiver_version_id='academy-v1' WHERE id='academy'"))
check("nor without a waiver", refused(db,
      "UPDATE programs SET status='open', price_cents=15000, waiver_version_id=NULL WHERE id='academy'"))
check("nor as a subscription with no PayPal plan", refused(db,
      "UPDATE programs SET status='open', price_cents=15000, waiver_version_id='academy-v1', "
      "paypal_plan_id_live=NULL, paypal_plan_id_sandbox=NULL WHERE id='academy'"))
check("with price, plan and waiver it opens", accepted(db,
      "UPDATE programs SET status='open', price_cents=15000, waiver_version_id='academy-v1' WHERE id='academy'"))
check("an inverted grade range is refused", refused(db, "UPDATE programs SET grade_min=6, grade_max=3 WHERE id='academy'"))

print("\n=== enrollments ===")
ENR = ("INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, offer_expires_at, "
       "applied_at, created_by, created_at, updated_at) VALUES (?, ?, ?, 'academy', ?, ?, ?, ?, 'account:1', ?, ?)")
check("an application is recorded", accepted(db, ENR, ("ref-1", KID, HH, None, "applied", None, NOW, NOW, NOW)))
db.execute(ENR, ("ref-1", KID, HH, None, "applied", None, NOW, NOW, NOW))
check("a second live enrollment for the same child and program is refused",
      refused(db, ENR, ("ref-2", KID, HH, None, "applied", None, NOW, NOW, NOW)))
# Cancelled, so only the ref index can refuse it.
check("a duplicate ref is refused", refused(db, ENR, ("ref-1", KID, HH, None, "cancelled", None, NOW, NOW, NOW)))
check("an offer must name a group", refused(db, "UPDATE enrollments SET status='offered', offer_expires_at=? WHERE ref='ref-1'", (NOW,)))
check("an offer must expire", refused(db, "UPDATE enrollments SET status='offered', group_id=? WHERE ref='ref-1'", (GROUP,)))
check("an offer with a group and an expiry is accepted", accepted(db,
      "UPDATE enrollments SET status='offered', group_id=?, offer_expires_at=? WHERE ref='ref-1'", (GROUP, NOW)))
check("an unknown status is refused", refused(db, "UPDATE enrollments SET status='paid' WHERE ref='ref-1'"))
db.execute("UPDATE enrollments SET status='cancelled' WHERE ref='ref-1'")
check("once cancelled, the child can apply again", accepted(db, ENR, ("ref-3", KID, HH, None, "applied", None, NOW, NOW, NOW)))
db.execute(ENR, ("ref-3", KID, HH, GROUP, "active", None, NOW, NOW, NOW))
ENROLL_ID = db.execute("SELECT id FROM enrollments WHERE ref='ref-3'").fetchone()[0]

print("\n=== billing ===")
SUB = ("INSERT INTO billing_subscriptions (paypal_subscription_id, environment, status, enrollment_id, source, "
       "created_at, updated_at) VALUES (?, 'sandbox', ?, ?, 'portal', ?, ?)")
check("a subscription links to an enrollment", accepted(db, SUB, ("I-ONE", "ACTIVE", ENROLL_ID, NOW, NOW)))
db.execute(SUB, ("I-ONE", "ACTIVE", ENROLL_ID, NOW, NOW))
check("a second live subscription for the same enrollment is refused",
      refused(db, SUB, ("I-TWO", "ACTIVE", ENROLL_ID, NOW, NOW)))
check("the same PayPal id cannot be recorded twice", refused(db, SUB, ("I-ONE", "CANCELLED", None, NOW, NOW)))
db.execute("UPDATE billing_subscriptions SET status='CANCELLED' WHERE paypal_subscription_id='I-ONE'")
check("after cancelling, a new subscription for the same child is allowed",
      accepted(db, SUB, ("I-THREE", "ACTIVE", ENROLL_ID, NOW, NOW)))
PAY = ("INSERT INTO payments (paypal_transaction_id, environment, amount_cents, currency, kind, status, paid_at, "
       "created_at) VALUES (?, 'sandbox', 4000, 'USD', ?, 'COMPLETED', ?, ?)")
check("a payment kind must be known", refused(db, PAY, ("T-1", "donation", NOW, NOW)))
db.execute(PAY, ("T-1", "setup_fee", NOW, NOW))
check("a transaction is recorded once", refused(db, PAY, ("T-1", "setup_fee", NOW, NOW)))

print("\n=== CRM ===")
db.execute("INSERT INTO crm_contacts (kind, email, email_norm, source, created_at, updated_at) "
           "VALUES ('family', 'Lead@Example.com', 'lead@example.com', 'website:player', ?, ?)", (NOW, NOW))
CONTACT = db.execute("SELECT id FROM crm_contacts").fetchone()[0]
check("one contact per email", refused(db,
      "INSERT INTO crm_contacts (kind, email_norm, source, created_at, updated_at) VALUES ('family', 'lead@example.com', 'manual', ?, ?)",
      (NOW, NOW)))
check("contacts whose email was cleared on conversion do not collide", accepted(db,
      "INSERT INTO crm_contacts (kind, email_norm, status, source, created_at, updated_at) VALUES ('family', NULL, 'converted', 'manual', ?, ?)",
      (NOW, NOW)) and accepted(db,
      "INSERT INTO crm_contacts (kind, email_norm, status, source, created_at, updated_at) VALUES ('family', NULL, 'converted', 'manual', ?, ?)",
      (NOW, NOW)))
db.execute("INSERT INTO crm_prospect_players (contact_id, name, created_at, updated_at) VALUES (?, 'Prospect Kid', ?, ?)",
           (CONTACT, NOW, NOW))
PROSPECT = db.execute("SELECT id FROM crm_prospect_players").fetchone()[0]
OPP = ("INSERT INTO crm_opportunities (pipeline, stage, contact_id, prospect_player_id, opened_at, created_at, updated_at) "
       "VALUES (?, ?, ?, ?, ?, ?, ?)")
check("a card on a stage that does not exist is refused", refused(db, OPP, ("family", "hot_lead", CONTACT, PROSPECT, NOW, NOW, NOW)))
check("a card on a real stage is accepted", accepted(db, OPP, ("family", "new", CONTACT, PROSPECT, NOW, NOW, NOW)))
db.execute(OPP, ("family", "new", CONTACT, PROSPECT, NOW, NOW, NOW))
check("a second open card for the same prospect child is refused", refused(db, OPP, ("family", "contacted", CONTACT, PROSPECT, NOW, NOW, NOW)))
check("an inquiry purpose must be known", refused(db,
      "INSERT INTO crm_inquiries (purpose, fields, received_at) VALUES ('donate', '{}', ?)", (NOW,)))

print("\n=== platform ===")
db.execute("INSERT INTO job_runs (job, run_key, status, started_at) VALUES ('crm_reconcile', '2026-09-26', 'running', ?)", (NOW,))
check("a job cannot be claimed twice for the same run", refused(db,
      "INSERT INTO job_runs (job, run_key, status, started_at) VALUES ('crm_reconcile', '2026-09-26', 'running', ?)", (NOW,)))

fk = db.execute("PRAGMA foreign_key_check").fetchall()
check("no dangling foreign keys at the end", fk == [], fk)

print("\n" + "=" * 62)
print(f"PASSED: {len(passed)}    FAILED: {len(failed)}")
if failed:
    print("\nFailures:")
    for f in failed:
        print("  - " + f)
print("=" * 62)
sys.exit(1 if failed else 0)
