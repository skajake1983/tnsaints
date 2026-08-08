/**
 * Server-side validation.
 *
 * These rules intentionally mirror the HTML pattern attributes on the site,
 * but they are the authoritative copy. Client validation is a convenience for
 * honest visitors; anything that reaches the database has to pass here.
 */

const NAME_RE = /^[A-Za-zÀ-ÿ' -]{2,60}$/;
const SCHOOL_RE = /^[A-Za-z0-9À-ÿ'&., -]{2,80}$/;
const PHONE_RE = /^(?:\+1\s?)?(?:\(\d{3}\)|\d{3})[ -]?\d{3}[ -]?\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/.+/i;

const GRADES = ['3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateRegistration(body, env) {
  const errors = [];
  const sessions = String(env.SESSION_TIMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sessionTime = str(body.session_time);
  if (!sessions.includes(sessionTime)) {
    errors.push('Please choose one of the available session times.');
  }

  const playerName = str(body.player_name);
  if (!NAME_RE.test(playerName)) errors.push('Please enter a valid player name.');

  const grade = str(body.grade);
  if (!GRADES.includes(grade)) errors.push('Please select a valid grade.');

  // Optional field, but reject nonsense rather than silently storing it.
  let yearsExperience = null;
  if (body.years_experience !== undefined && body.years_experience !== '') {
    const n = Number(body.years_experience);
    if (!Number.isInteger(n) || n < 0 || n > 15) {
      errors.push('Years of experience must be a whole number between 0 and 15.');
    } else {
      yearsExperience = n;
    }
  }

  const parentName = str(body.parent_name);
  if (!NAME_RE.test(parentName)) errors.push('Please enter a valid parent or guardian name.');

  const parentEmail = str(body.parent_email);
  if (!EMAIL_RE.test(parentEmail) || parentEmail.length > 254) {
    errors.push('Please enter a valid parent email address.');
  }

  const phone = str(body.phone);
  if (!PHONE_RE.test(phone)) errors.push('Please enter a valid parent phone number.');

  const school = str(body.school);
  if (!SCHOOL_RE.test(school)) errors.push('Please enter a valid school name.');

  const emergencyName = str(body.emergency_contact_name);
  if (!NAME_RE.test(emergencyName)) errors.push('Please enter a valid emergency contact name.');

  const emergencyPhone = str(body.emergency_contact_phone);
  if (!PHONE_RE.test(emergencyPhone)) errors.push('Please enter a valid emergency contact phone number.');

  const highlightLink = str(body.highlight_link);
  if (highlightLink && (!URL_RE.test(highlightLink) || highlightLink.length > 500)) {
    errors.push('Highlight link must be a full URL starting with http:// or https://.');
  }

  const playerNotes = str(body.player_notes);
  if (playerNotes.length < 15 || playerNotes.length > 1000) {
    errors.push('Player notes must be between 15 and 1000 characters.');
  }

  const medicalNotes = str(body.medical_notes);
  if (medicalNotes.length > 1000) {
    errors.push('Medical notes must be 1000 characters or fewer.');
  }

  // Participation acknowledgements. The two required ones are also enforced by
  // CHECK constraints in the schema, so a row cannot exist without them.
  const assumptionOfRisk = body.assumption_of_risk === true;
  if (!assumptionOfRisk) {
    errors.push('Please acknowledge the assumption of risk to continue.');
  }

  const medicalRelease = body.medical_release === true;
  if (!medicalRelease) {
    errors.push('Please authorize emergency medical care to continue.');
  }

  // Optional by design — media consent for a minor should be a real choice.
  const photoRelease = body.photo_release === true;

  const signature = str(body.signature);
  if (!NAME_RE.test(signature)) {
    errors.push('Please type the parent or guardian full legal name as a signature.');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      session_time: sessionTime,
      player_name: playerName,
      player_name_norm: playerName.toLowerCase().replace(/\s+/g, ' '),
      grade,
      years_experience: yearsExperience,
      parent_name: parentName,
      parent_email: parentEmail,
      parent_email_norm: parentEmail.toLowerCase(),
      phone,
      school,
      emergency_contact_name: emergencyName,
      emergency_contact_phone: emergencyPhone,
      medical_notes: medicalNotes || null,
      assumption_of_risk: 1,
      medical_release: 1,
      photo_release: photoRelease ? 1 : 0,
      signature,
      highlight_link: highlightLink || null,
      player_notes: playerNotes,
    },
  };
}

/**
 * Cheap bot signals that cost a real visitor nothing.
 *
 * `company` is a honeypot: it is hidden from humans via CSS, so any value at
 * all means an automated form-filler walked the DOM.
 */
export function botSignals(body) {
  const reasons = [];

  if (str(body.company)) reasons.push('honeypot');

  // Clock is client-supplied and therefore untrusted — it only filters
  // scripted submits that never rendered the page. Treated as a soft signal.
  const elapsed = Number(body.elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 3000) {
    reasons.push('too-fast');
  }

  return reasons;
}
