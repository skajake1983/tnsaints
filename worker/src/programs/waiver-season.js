/**
 * When a family must sign a program's waiver again.
 *
 * Tennessee asks that each player and a parent review the state's concussion
 * and head injury information sheet every year (Tenn. Code Ann. 68-55-503),
 * and the academy waiver records that review. So a signature lasts one
 * season: from WAIVER_SEASON_STARTS ("MM-DD", Central; default "08-01", the
 * owner's choice on 2026-10-10) to the next one. A place also needs a new
 * signature when its program's waiver changes (a new version, say one naming
 * the non-profit).
 *
 * Only places that exist need it: active or past due. An application signs
 * its waiver as it is made.
 */

import { parseMonthDay } from '../lib/grades.js';
import { centralToIso } from './manage.js';

const DEFAULT_START = { month: 8, day: 1 };
let warned = false;

/** The instant (ISO, UTC) the current waiver season began: the latest season start at or before `nowMs`, Central. */
export function waiverSeasonStart(env, nowMs = Date.now()) {
  const raw = env?.WAIVER_SEASON_STARTS;
  const parsed = raw ? parseMonthDay(raw) : null;
  if (raw && !parsed && !warned) {
    warned = true;
    console.warn(JSON.stringify({ event: 'flag_invalid', name: 'WAIVER_SEASON_STARTS' }));
  }
  const { month, day } = parsed || DEFAULT_START;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(nowMs));
  const start = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const year = Number(today.slice(0, 4)) - (today.slice(5) >= start ? 0 : 1);
  return centralToIso(`${year}-${start}T00:00`);
}

/**
 * Does this place need a (new) signature? `place` carries status,
 * consent_record_id, consent_signed_at, consent_waiver_id and
 * program_waiver_id (see familyEnrollments and liveEnrollment).
 */
export function needsWaiver(place, seasonStart) {
  if (!place || !['active', 'past_due'].includes(place.status)) return false;
  if (!place.consent_record_id || !place.consent_signed_at) return true;
  if (place.program_waiver_id && place.consent_waiver_id !== place.program_waiver_id) return true;
  return String(place.consent_signed_at) < String(seasonStart);
}

/** The state's concussion information sheet, if configured as an https link (CONCUSSION_SHEET_URL). */
export function concussionSheetUrl(env) {
  const raw = String(env?.CONCUSSION_SHEET_URL || '').trim();
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
