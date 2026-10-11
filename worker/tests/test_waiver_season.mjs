/**
 * The waiver season (src/programs/waiver-season.js): signatures last from one
 * WAIVER_SEASON_STARTS (default August 1, Central) to the next, and a new
 * waiver version needs a new signature.
 *
 *   node tests/test_waiver_season.mjs
 */
import { checker } from './_d1_fake.mjs';
import { waiverSeasonStart, needsWaiver, concussionSheetUrl } from '../src/programs/waiver-season.js';

const check = checker();
const at = (iso) => Date.parse(iso);

console.log('\n=== when the season starts ===');
// August 1, midnight Central (CDT, UTC-5) is 05:00 UTC.
check('on August 1 (Central) the new season has begun', waiverSeasonStart({}, at('2026-08-01T05:00:00Z')) === '2026-08-01T05:00:00.000Z',
  waiverSeasonStart({}, at('2026-08-01T05:00:00Z')));
check('at 11 PM on July 31 Central (already August 1 in UTC) it has not',
  waiverSeasonStart({}, at('2026-08-01T04:00:00Z')) === '2025-08-01T05:00:00.000Z', waiverSeasonStart({}, at('2026-08-01T04:00:00Z')));
check('in spring, the season is last August\'s', waiverSeasonStart({}, at('2027-03-15T12:00:00Z')) === '2026-08-01T05:00:00.000Z');
check('a configured day is used, in Central winter time too',
  waiverSeasonStart({ WAIVER_SEASON_STARTS: '01-01' }, at('2027-03-15T12:00:00Z')) === '2027-01-01T06:00:00.000Z',
  waiverSeasonStart({ WAIVER_SEASON_STARTS: '01-01' }, at('2027-03-15T12:00:00Z')));
check('a malformed or impossible day keeps August 1',
  waiverSeasonStart({ WAIVER_SEASON_STARTS: '02-30' }, at('2027-03-15T12:00:00Z')) === '2026-08-01T05:00:00.000Z'
  && waiverSeasonStart({ WAIVER_SEASON_STARTS: 'August' }, at('2027-03-15T12:00:00Z')) === '2026-08-01T05:00:00.000Z');

console.log('\n=== who needs to sign ===');
const season = '2026-08-01T05:00:00.000Z';
const place = (o) => ({ status: 'active', consent_record_id: 7, consent_signed_at: '2026-09-01T00:00:00.000Z',
  consent_waiver_id: 'academy-v1', program_waiver_id: 'academy-v1', ...o });
check('signed this season, current version: no', needsWaiver(place({}), season) === false);
check('never signed: yes', needsWaiver(place({ consent_record_id: null, consent_signed_at: null }), season) === true);
check('signed last season: yes', needsWaiver(place({ consent_signed_at: '2026-07-31T23:00:00.000Z' }), season) === true);
check('signed this season but for an older version: yes', needsWaiver(place({ program_waiver_id: 'academy-v2' }), season) === true);
check('a past-due place too', needsWaiver(place({ status: 'past_due', consent_record_id: null }), season) === true);
check('an application or an offer: no (they sign as they apply)',
  needsWaiver(place({ status: 'applied', consent_record_id: null }), season) === false
  && needsWaiver(place({ status: 'offered', consent_signed_at: '2025-01-01T00:00:00.000Z' }), season) === false);
check('no place at all: no', needsWaiver(null, season) === false);

console.log('\n=== the concussion sheet link ===');
check('an https link is used', concussionSheetUrl({ CONCUSSION_SHEET_URL: 'https://tnsaints.com/concussion-sheet.pdf' })
  === 'https://tnsaints.com/concussion-sheet.pdf');
check('anything else is not', [undefined, '', 'http://tnsaints.com/x.pdf', 'javascript:alert(1)', 'https://u:p@tnsaints.com/x.pdf', 'not a url']
  .every((v) => concussionSheetUrl({ CONCUSSION_SHEET_URL: v }) === null));

check.finish();
