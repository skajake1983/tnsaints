/**
 * Retention: removing what the academy no longer needs, on a schedule, so
 * children's data is not kept forever by default.
 *
 * REPORT FIRST. RETENTION_MODE is "report" (the default, and anything that is
 * not exactly "enforce"): the daily job counts what each rule WOULD remove and
 * shows it on Admin -> Privacy, removing nothing. The plan is two weeks of
 * reports, then "enforce" — and the periods below are DEFAULTS PENDING THE
 * ATTORNEY'S REVIEW (plan item O15). Each is a setting.
 *
 *   medical_portal   a child's medical answer, 90 days after their last place
 *                    ended (only children who had a place; never while one is live)
 *   medical_eval     an evaluation registration's medical note, 90 days after
 *                    the evaluation
 *   leads            a contact never converted and untouched for 24 months:
 *                    anonymized (crm/store.js semantics), not deleted
 *   waivers          a signed waiver, once BOTH 7 years have passed AND the
 *                    child has turned 21 (kept while their age is unknown)
 *   payments         a payment record, after 7 years
 *
 * A LEGAL HOLD (legal_holds) on a family, child, contact or registration keeps
 * everything about it out of every rule until released.
 *
 * Bounded: at most BATCH rows per rule per run; the rest go next run. Each
 * enforcement re-checks its rule inside the statement that removes, so a row
 * that changed after it was counted is left alone. The audit log gets counts
 * only.
 */

import { choice } from '../lib/flags.js';
import { audit } from '../auth/staff.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const REPORT_KEY = 'retention.report';
// D1 wants exactly as many bound values as the highest ?N in a statement.
// Every rule statement binds all six cutoffs, so each names ?6.
const ALL = `?6 IS NOT NULL`;

function bounded(raw, fallback, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function retentionConfig(env) {
  return {
    mode: choice(env, 'RETENTION_MODE', ['report', 'enforce'], 'report'),
    medicalDays: bounded(env.RETENTION_MEDICAL_DAYS, 90, 30, 3650),
    leadMonths: bounded(env.RETENTION_LEAD_MONTHS, 24, 6, 120),
    waiverYears: bounded(env.RETENTION_WAIVER_YEARS, 7, 1, 30),
    waiverMinAge: bounded(env.RETENTION_WAIVER_MIN_AGE, 21, 18, 30),
    paymentYears: bounded(env.RETENTION_PAYMENT_YEARS, 7, 1, 30),
  };
}

const HOLD = (type, expr) =>
  `EXISTS (SELECT 1 FROM legal_holds lh WHERE lh.released_at IS NULL AND lh.subject_type = '${type}' AND lh.subject_id = ${expr})`;
const HELD_PLAYER = (expr) =>
  `(${HOLD('player', expr)} OR ${HOLD('household', `(SELECT hp.household_id FROM players hp WHERE hp.id = ${expr})`)})`;
const EVENT_DATE = `(CASE WHEN r.event_id GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                          THEN substr(r.event_id, 1, 10) ELSE substr(r.created_at, 1, 10) END)`;

/**
 * Each rule: the rows it covers (`from`), when one is due (`due`, binding the
 * cutoffs below), what keeps it (`held`), and its key column.
 * Cutoffs: ?1 medical (ISO), ?2 medical (date), ?3 leads (ISO), ?4 waivers
 * (ISO), ?5 today minus the minimum age (date), ?6 payments (ISO).
 */
export const RULES = [
  {
    key: 'medical_portal', label: "Children's medical answers, 90 days after their last place ended",
    from: 'player_medical pm', id: 'pm.player_id',
    due: `EXISTS (SELECT 1 FROM enrollments e WHERE e.player_id = pm.player_id)
          AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.player_id = pm.player_id AND e.status IN ${LIVE})
          AND (SELECT MAX(COALESCE(e.ended_at, e.updated_at)) FROM enrollments e WHERE e.player_id = pm.player_id) < ?1
          AND pm.updated_at < ?1`,
    held: HELD_PLAYER('pm.player_id'),
  },
  {
    key: 'medical_eval', label: "Evaluation registrations' medical notes, 90 days after the evaluation",
    from: 'registrations r', id: 'r.id',
    due: `r.medical_notes IS NOT NULL AND trim(r.medical_notes) != '' AND ${EVENT_DATE} < ?2`,
    held: `(${HOLD('registration', 'r.id')} OR (r.player_id IS NOT NULL AND ${HELD_PLAYER('r.player_id')}))`,
  },
  {
    key: 'leads', label: 'Contacts never converted, untouched for 24 months (anonymized)',
    from: 'crm_contacts c', id: 'c.id',
    due: `c.status = 'active' AND c.household_id IS NULL
          AND MAX(c.created_at, c.updated_at,
                  COALESCE((SELECT MAX(i.received_at) FROM crm_inquiries i WHERE i.contact_id = c.id), ''),
                  COALESCE((SELECT MAX(a.occurred_at) FROM crm_activities a WHERE a.contact_id = c.id), '')) < ?3
          AND NOT EXISTS (SELECT 1 FROM crm_opportunities o JOIN crm_stages s ON s.pipeline = o.pipeline AND s.stage = o.stage
                           WHERE o.contact_id = c.id AND s.outcome = 'won')`,
    held: HOLD('crm_contact', 'c.id'),
  },
  {
    key: 'waivers', label: 'Signed waivers, once 7 years have passed and the child is 21',
    from: 'consent_records cr', id: 'cr.id',
    due: `cr.signed_at < ?4
          AND (SELECT p.date_of_birth FROM players p WHERE p.id = cr.player_id) IS NOT NULL
          AND (SELECT p.date_of_birth FROM players p WHERE p.id = cr.player_id) < ?5
          AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.player_id = cr.player_id AND e.status IN ${LIVE})`,
    held: `(${HELD_PLAYER('cr.player_id')} OR ${HOLD('household', 'cr.household_id')})`,
  },
  {
    key: 'payments', label: 'Payment records, after 7 years',
    from: 'payments p', id: 'p.id',
    due: `p.paid_at < ?6`,
    held: `(p.household_id IS NOT NULL AND ${HOLD('household', 'p.household_id')})`,
  },
];

function cutoffs(config, now) {
  const t = now.getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const medical = t - config.medicalDays * DAY_MS;
  const minus = (years, months = 0) => {
    const d = new Date(t);
    d.setUTCFullYear(d.getUTCFullYear() - years, d.getUTCMonth() - months);
    return d;
  };
  return [
    iso(medical),
    iso(medical).slice(0, 10),
    minus(0, config.leadMonths).toISOString(),
    minus(config.waiverYears).toISOString(),
    minus(config.waiverMinAge).toISOString().slice(0, 10),
    minus(config.paymentYears).toISOString(),
  ];
}

/** What each rule would remove now, and what holds keep. Two counts per rule, plus waivers of unknown age. */
export async function retentionCounts(env, { now = new Date(), config = retentionConfig(env) } = {}) {
  const binds = cutoffs(config, now);
  const statements = RULES.flatMap((r) => [
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${r.from} WHERE ${r.due} AND NOT ${r.held} AND ${ALL}`).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${r.from} WHERE ${r.due} AND ${r.held} AND ${ALL}`).bind(...binds),
  ]);
  statements.push(env.DB.prepare(
    `SELECT COUNT(*) AS n FROM consent_records cr
      WHERE cr.signed_at < ?4 AND (SELECT p.date_of_birth FROM players p WHERE p.id = cr.player_id) IS NULL
        AND ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL AND ?5 IS NOT NULL AND ?6 IS NOT NULL`
  ).bind(...binds));
  const results = await env.DB.batch(statements);
  const n = (i) => Number(results[i].results?.[0]?.n || 0);
  return {
    at: now.toISOString(),
    mode: config.mode,
    rules: RULES.map((r, i) => ({ key: r.key, label: r.label, due: n(2 * i), held: n(2 * i + 1) })),
    waiversAgeUnknown: n(RULES.length * 2),
  };
}

/** The statements that remove one batch of a rule's rows, given their ids (JSON). Each re-checks the rule. */
function enforcement(env, rule, idsJson, binds) {
  const recheck = `${rule.id} IN (SELECT value FROM json_each(?7)) AND ${rule.due} AND NOT ${rule.held}`;
  const p = (sql) => env.DB.prepare(sql).bind(...binds, idsJson);
  switch (rule.key) {
    case 'medical_portal':
      return [p(`DELETE FROM player_medical WHERE player_id IN (SELECT pm.player_id FROM player_medical pm WHERE ${recheck})`)];
    case 'medical_eval':
      return [p(`UPDATE registrations SET medical_notes = NULL WHERE id IN (SELECT r.id FROM registrations r WHERE ${recheck})`)];
    case 'leads': {
      const now = new Date().toISOString();
      const mine = `contact_id IN (SELECT value FROM json_each(?7)) AND ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL
                    AND ?4 IS NOT NULL AND ?5 IS NOT NULL AND ?6 IS NOT NULL
                    AND contact_id IN (SELECT id FROM crm_contacts WHERE status = 'anonymized')`;
      return [
        p(`UPDATE crm_contacts SET status = 'anonymized', name = NULL, email = NULL, email_norm = NULL, phone = NULL,
                  phone_norm = NULL, organization = NULL, owner_email = NULL, updated_at = '${now}'
            WHERE id IN (SELECT c.id FROM crm_contacts c WHERE ${recheck})`),
        p(`UPDATE crm_prospect_players SET name = '', school = NULL, position = NULL WHERE ${mine}`),
        p(`UPDATE crm_inquiries SET fields = '{}', message = NULL, ip_hash = NULL WHERE ${mine}`),
        p(`UPDATE crm_activities SET body = NULL WHERE ${mine}`),
        p(`UPDATE crm_tasks SET title = '(removed)', status = CASE WHEN status = 'open' THEN 'cancelled' ELSE status END
            WHERE ${mine}`),
        p(`UPDATE crm_opportunities SET closed_at = COALESCE(closed_at, '${now}') WHERE ${mine}`),
      ];
    }
    case 'waivers':
      return [
        // An ended place keeps no pointer to a waiver that is going.
        p(`UPDATE enrollments SET consent_record_id = NULL
            WHERE status NOT IN ${LIVE}
              AND consent_record_id IN (SELECT cr.id FROM consent_records cr WHERE ${recheck})`),
        p(`DELETE FROM consent_records WHERE id IN (SELECT cr.id FROM consent_records cr WHERE ${recheck})
              AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.consent_record_id = consent_records.id)`),
      ];
    case 'payments':
      return [p(`DELETE FROM payments WHERE id IN (SELECT p.id FROM payments p WHERE ${recheck})`)];
    default:
      return [];
  }
}

/**
 * The daily job: count, and in enforce mode remove one batch per rule.
 * Saves the report for Admin -> Privacy.
 */
export async function runRetention(env, { now = new Date(), config = retentionConfig(env) } = {}) {
  const report = await retentionCounts(env, { now, config });
  const removed = {};
  if (config.mode === 'enforce') {
    const binds = cutoffs(config, now);
    for (const rule of RULES) {
      if (!report.rules.find((r) => r.key === rule.key)?.due) continue;
      const { results } = await env.DB.prepare(
        `SELECT ${rule.id} AS id FROM ${rule.from} WHERE ${rule.due} AND NOT ${rule.held} AND ${ALL} LIMIT ${BATCH}`
      ).bind(...binds).all();
      const ids = (results || []).map((r) => r.id);
      if (!ids.length) continue;
      const out = await env.DB.batch(enforcement(env, rule, JSON.stringify(ids), binds));
      removed[rule.key] = out[rule.key === 'waivers' ? 1 : 0].meta?.changes || 0;
    }
    if (Object.keys(removed).length) {
      await audit(env, { actor: 'system', action: 'retention.enforced', detail: removed });
    }
  }
  const saved = { ...report, removed };
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, 'system', ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(REPORT_KEY, JSON.stringify(saved), now.toISOString()).run();
  return saved;
}

/** The last saved report, or null. */
export async function lastRetentionReport(env) {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?1`).bind(REPORT_KEY).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
