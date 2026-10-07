/**
 * Programs as data (events:manage): create camps, clinics, tournaments, teams
 * and evaluations, and set what families see about them.
 *
 * Price, groups and waivers keep their own forms (programs/settings.js). Here:
 * the program's identity (created once: id, kind, billing), and its details —
 * name, description, who can see it, how families join, when sign-up opens
 * and closes.
 *
 * The academy is an approval program by the owner's rule (no paying without a
 * staff-offered seat in a scheduled group); its joining mode cannot be changed
 * here. Billing is fixed while families hold places: changing how a program
 * is paid for under them is not a settings change.
 */

const iso = () => new Date().toISOString();
const ID = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const PROGRAM_KINDS = ['camp', 'clinic', 'tournament', 'team', 'evaluation', 'academy'];
export const BILLINGS = ['one_time', 'subscription', 'free'];
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const text = (form, key, max) => String(form.get(key) || '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

/** "2026-11-01T18:00" typed in Central time -> an ISO instant, or null if malformed. */
export function centralToIso(local) {
  if (!DATE_TIME.test(String(local || ''))) return null;
  const [d, t] = local.split('T');
  // Try both Central offsets; keep the one that formats back to the same wall time.
  for (const offset of ['-05:00', '-06:00']) {
    const at = new Date(`${d}T${t}:00${offset}`);
    // "2026-13-40T99:00" has the right shape and no meaning.
    if (Number.isNaN(at.getTime())) return null;
    const back = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(at).replace(' ', 'T');
    if (back === local) return at.toISOString();
  }
  return null;
}

/** An ISO instant -> "YYYY-MM-DDTHH:MM" in Central time, for a datetime-local input. */
export function isoToCentral(value) {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at).replace(' ', 'T');
}

export async function listPrograms(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.name, p.status, p.billing, p.enrollment_mode, p.public, p.registration_closes_at,
            (SELECT COUNT(*) FROM enrollments e WHERE e.program_id = p.id AND e.status IN ('active', 'past_due')) AS enrolled,
            (SELECT COUNT(*) FROM enrollments e WHERE e.program_id = p.id AND e.status IN ('applied', 'waitlist', 'offered')) AS waiting,
            (SELECT COUNT(*) FROM program_groups g WHERE g.program_id = p.id AND g.status = 'active') AS groups
       FROM programs p WHERE p.status != 'archived'
      ORDER BY p.status = 'open' DESC, p.kind = 'academy' DESC, p.created_at DESC LIMIT 200`
  ).all();
  return results || [];
}

/**
 * New program, in draft. Teams and the academy are approval programs; camps,
 * clinics and tournaments default to self-serve; evaluations are free.
 * @returns {Promise<{result: 'created'|'invalid'|'exists', id?: string, errors?: object}>}
 */
export async function createProgram(env, form) {
  const id = String(form.get('id') || '').trim().toLowerCase();
  const kind = String(form.get('kind') || '');
  const name = text(form, 'name', 120);
  let billing = String(form.get('billing') || '');
  const errors = {};
  if (!ID.test(id)) errors.id = 'Use 3–40 lowercase letters, numbers and dashes, like summer-camp-2027.';
  if (!PROGRAM_KINDS.includes(kind) || kind === 'academy') errors.kind = 'Choose what kind of program this is.';
  if (!name || name.length > 120) errors.name = 'Give it a name families will recognise (up to 120 characters).';
  if (kind === 'evaluation') billing = 'free';
  if (!BILLINGS.includes(billing)) errors.billing = 'Choose how it is paid for.';
  if (Object.keys(errors).length) return { result: 'invalid', errors };
  const mode = ['team', 'evaluation'].includes(kind) ? 'approval' : 'self_serve';
  const now = iso();
  try {
    await env.DB.prepare(
      `INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, currency, public, waitlist_enabled,
                             created_at, updated_at)
       VALUES (?1, ?2, ?3, 'draft', ?4, ?5, 'USD', 0, 1, ?6, ?6)`
    ).bind(id, kind, name, mode, billing, now).run();
    return { result: 'created', id };
  } catch (err) {
    if (/UNIQUE|PRIMARY/i.test(String(err?.message))) return { result: 'exists', errors: { id: 'A program with that id already exists.' } };
    throw err;
  }
}

/**
 * Name, description, visibility, joining mode, waiting list, sign-up window.
 * @returns {Promise<'details-saved'|'invalid'>}
 */
export async function saveProgramDetails(env, program, form) {
  const name = text(form, 'name', 120);
  const description = String(form.get('description') || '').trim().slice(0, 801);
  const isPublic = form.get('public') === '1' ? 1 : 0;
  const waitlist = form.get('waitlist_enabled') === '1' ? 1 : 0;
  const wantedMode = String(form.get('enrollment_mode') || program.enrollment_mode);
  const mode = program.kind === 'academy' ? 'approval' : wantedMode;
  const opensRaw = String(form.get('registration_opens_at') || '');
  const closesRaw = String(form.get('registration_closes_at') || '');
  const opens = opensRaw ? centralToIso(opensRaw) : null;
  const closes = closesRaw ? centralToIso(closesRaw) : null;
  if (!name || name.length > 120 || description.length > 800 || !['approval', 'self_serve'].includes(mode)) return 'invalid';
  if ((opensRaw && !opens) || (closesRaw && !closes) || (opens && closes && opens >= closes)) return 'invalid';
  const res = await env.DB.prepare(
    `UPDATE programs SET name = ?2, description = ?3, public = ?4, waitlist_enabled = ?5, enrollment_mode = ?6,
            registration_opens_at = ?7, registration_closes_at = ?8, updated_at = ?9
      WHERE id = ?1`
  ).bind(program.id, name, description || null, isPublic, waitlist, mode, opens, closes, iso()).run();
  return res.meta?.changes ? 'details-saved' : 'invalid';
}
