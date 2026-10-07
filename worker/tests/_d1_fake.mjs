/**
 * A D1 binding over Node's built-in SQLite, for tests that need real SQL but
 * not a running Worker: the real schema and migrations, the D1 API surface the
 * code uses (prepare / bind / first / run / all / raw / batch), and a count of
 * every query that reaches the database.
 *
 * Not a copy of D1's every quirk: it binds integers as INTEGER where D1 binds
 * every JS number as REAL. Code that depends on that difference is tested
 * against the dev server instead.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const toSql = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const plain = (row) => (row ? { ...row } : row);

export function fakeD1({ migrate = true } = {}) {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; so does this.
  db.exec('PRAGMA foreign_keys = ON');
  const stats = { queries: 0 };
  if (migrate) {
    db.exec(readFileSync(join(WORKER_DIR, 'schema.sql'), 'utf8'));
    const dir = join(WORKER_DIR, 'migrations');
    for (const f of readdirSync(dir).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) {
      const sql = readFileSync(join(dir, f), 'utf8');
      try {
        db.exec(sql);
      } catch (err) {
        // The local migrator's rule (tests/migrate_local_db.py): an ALTER-only
        // file whose column schema.sql already has is "already applied". Apply
        // its statements one by one, skipping only those duplicates.
        if (!/duplicate column name/.test(err.message)) throw err;
        for (const piece of sql.split(/;\s*\n/)) {
          if (!piece.replace(/--.*$/gm, '').trim()) continue;
          try {
            db.exec(`${piece};`);
          } catch (inner) {
            if (!/duplicate column name/.test(inner.message)) throw inner;
          }
        }
      }
    }
  }

  const execute = (sql, args) => {
    stats.queries += 1;
    const stmt = db.prepare(sql);
    const reader = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (reader) {
      const results = stmt.all(...args).map(plain);
      return { results, success: true, meta: { changes: 0, rows_read: results.length } };
    }
    const r = stmt.run(...args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };

  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => statement(sql, a.map(toSql)),
    first: async (col) => {
      const row = execute(sql, args).results[0] ?? null;
      return col === undefined ? row : row ? row[col] : null;
    },
    run: async () => execute(sql, args),
    all: async () => execute(sql, args),
    raw: async () => execute(sql, args).results.map((r) => Object.values(r)),
  });

  return {
    raw: db,
    stats,
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => execute(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** The suites' PASS/FAIL printer and exit code, in the same shape as the Python ones. */
export function checker() {
  const passed = [];
  const failed = [];
  const check = (label, cond, detail) => {
    (cond ? passed : failed).push(label);
    const extra = cond || detail === undefined ? '' : `   ${JSON.stringify(detail).slice(0, 300)}`;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra}`);
  };
  check.finish = () => {
    console.log(`\n${'='.repeat(62)}\nTOTAL PASSED: ${passed.length}    FAILED: ${failed.length}\n${'='.repeat(62)}`);
    process.exit(failed.length ? 1 : 0);
  };
  return check;
}
