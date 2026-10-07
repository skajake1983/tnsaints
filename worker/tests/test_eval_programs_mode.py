"""The evaluation suites again, with the evaluation running from a PROGRAM.

The plan's rule for moving the evaluation off wrangler.toml: every suite green
in both modes. This seeds an evaluation program that mirrors the configured
evaluation exactly — same id, label, sessions, session size, grades and close
time (wrangler.toml, with .dev.vars overriding, as the dev server reads them) —
makes it the current evaluation, confirms the admin roster says it is running
from the program, and runs each evaluation suite against it. Then it puts the
setting back.

Nothing is printed from .dev.vars.
"""
import hashlib
import os
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _d1 import wrangler_local
from _harness import preflight

BASE = "http://127.0.0.1:8787"
preflight(BASE)
HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.dirname(HERE)
SUITES = ["test_acceptance.py", "test_cancellation.py", "test_concurrency.py", "test_eval_capture.py",
          "test_decisions.py", "test_send_path.py", "test_siblings.py"]


def toml_vars():
    out = {}
    text = open(os.path.join(WORKER, "wrangler.toml"), encoding="utf-8").read()
    for m in re.finditer(r'^([A-Z_]+)\s*=\s*"([^"]*)"', text, re.M):
        out.setdefault(m.group(1), m.group(2))
    try:
        for line in open(os.path.join(WORKER, ".dev.vars"), encoding="utf-8"):
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"')
    except FileNotFoundError:
        pass
    return out


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


V = toml_vars()
EVENT = V["EVENT_ID"]
SESSIONS = [s.strip() for s in V["SESSION_TIMES"].split(",") if s.strip()]
GRADES = [g.strip() for g in V["ALLOWED_GRADES"].split(",") if g.strip()]
nums = [0 if g.upper() == "K" else int(re.match(r"\d+", g).group()) for g in GRADES]
WAIVER_TEXT = "Mirror of the evaluation's own waiver, which families accept on the registration form."
SHA = hashlib.sha256(WAIVER_TEXT.encode()).hexdigest()


def to_24h(t):
    m = re.match(r"^(\d{1,2}):(\d{2})\s*([AP]M)$", t.strip(), re.I)
    if not m:
        return None
    h = int(m.group(1)) % 12 + (12 if m.group(3).upper() == "PM" else 0)
    return f"{h:02d}:{m.group(2)}"


def seed():
    now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    statements = [
        "DELETE FROM app_settings WHERE key = 'evaluation.current'",
        f"DELETE FROM program_groups WHERE program_id = {q(EVENT)}",
        f"DELETE FROM programs WHERE id = {q(EVENT)}",
        "INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at) "
        f"VALUES ('evaluation-mirror-v1', 'Tennessee Saints', 'Evaluation waiver', {q(WAIVER_TEXT)}, {q(SHA)}, {now}, {now})",
        "INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, grade_min, grade_max, waiver_version_id, "
        f"public, registration_closes_at, created_at, updated_at) VALUES ({q(EVENT)}, 'evaluation', {q(V['EVENT_LABEL'])}, "
        f"'open', 'approval', 'free', {min(nums)}, {max(nums)}, 'evaluation-mirror-v1', 0, {q(V['REGISTRATION_CLOSES_AT'])}, "
        f"{now}, {now})",
    ]
    for s in SESSIONS:
        statements.append("INSERT INTO program_groups (program_id, name, schedule_summary, start_time, capacity, status, "
                          f"created_at, updated_at) VALUES ({q(EVENT)}, {q(s)}, {q(s)}, {q(to_24h(s))}, "
                          f"{int(V['SLOT_CAPACITY'])}, 'active', {now}, {now})")
    statements.append("INSERT INTO app_settings (key, value, updated_by, updated_at) "
                      f"VALUES ('evaluation.current', {q(EVENT)}, 'test', {now})")
    for s in statements:
        wrangler_local(s)


def overlay_active():
    try:
        with urllib.request.urlopen(BASE + "/__admin/") as r:
            return "Running from the evaluation program" in r.read().decode("utf-8", "replace")
    except Exception:
        return False


results = []
try:
    for suite in SUITES:
        subprocess.run([sys.executable, os.path.join(HERE, "reset_local_db.py")], cwd=WORKER, capture_output=True)
        seed()
        if not overlay_active():
            print(f"  FAIL  {suite}: the evaluation did not switch to the program")
            results.append((suite, False))
            continue
        print(f"\n##### {suite}, evaluation running from the program #####", flush=True)
        code = subprocess.run([sys.executable, os.path.join(HERE, suite)], cwd=WORKER).returncode
        results.append((suite, code == 0))
finally:
    wrangler_local("DELETE FROM app_settings WHERE key = 'evaluation.current'")

print("\n=== the evaluation suites, running from a program ===")
passed = [s for s, ok in results if ok]
failed = [s for s, ok in results if not ok]
for s, ok in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {s}")
print("\n" + "=" * 62)
print(f"TOTAL PASSED: {len(passed)}    FAILED: {len(failed)}")
print("=" * 62)
sys.exit(1 if failed or len(results) != len(SUITES) else 0)
