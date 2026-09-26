/**
 * School grades that stay correct without anyone touching them.
 *
 * A child's grade is stored as (grade_level, grade_school_year): "5th grade in
 * the 2026-27 school year". The grade shown today is derived, so it advances
 * by itself on July 1 — Central time, because that is when school years turn
 * over in Franklin — instead of being wrong from the first day of every August.
 *
 * 0 is kindergarten. Past 12th grade a child has graduated and is no longer a
 * youth player; `currentGrade` returns null.
 */

const ROLLOVER_MONTH = 7; // July

/** Year and month in America/Chicago, independent of where the Worker runs. */
function centralYearMonth(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric' })
    .formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year').value),
    month: Number(parts.find((p) => p.type === 'month').value),
  };
}

/** The school year a date falls in, named by its starting year: 2026 = 2026-27. */
export function schoolYearOf(date = new Date()) {
  const { year, month } = centralYearMonth(date);
  return month >= ROLLOVER_MONTH ? year : year - 1;
}

/** Today's grade (0-12) from a stored grade and the school year it was true for; null once graduated. */
export function currentGrade(gradeLevel, gradeSchoolYear, now = new Date()) {
  if (gradeLevel === null || gradeLevel === undefined || gradeSchoolYear === null || gradeSchoolYear === undefined) {
    return null;
  }
  const grade = Number(gradeLevel) + (schoolYearOf(now) - Number(gradeSchoolYear));
  return grade >= 0 && grade <= 12 ? grade : null;
}

export function gradeLabel(grade) {
  if (grade === null || grade === undefined) return '';
  if (grade === 0) return 'Kindergarten';
  const n = Number(grade);
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix} grade`;
}

/** The evaluation form's grade strings ("5th", "K") as a number, or null. */
export function parseLegacyGrade(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'k' || s.startsWith('kind')) return 0;
  const m = /^(\d{1,2})(st|nd|rd|th)?\b/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

/** Whole years of age on `now` for a YYYY-MM-DD birth date, or null if malformed. */
export function ageOn(dateOfBirth, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOfBirth || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dob = new Date(Date.UTC(y, mo - 1, d));
  if (dob.getUTCFullYear() !== y || dob.getUTCMonth() !== mo - 1 || dob.getUTCDate() !== d) return null;
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}
