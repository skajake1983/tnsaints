/**
 * What an event's sign-up form asks (the Events plan, phase EV3): one list per
 * kind and mode, sent to the website by GET /api/events/:id so the form is
 * built from it, and the same rules checked here when it is submitted.
 *
 *   spot      a place in a session. An evaluation asks what it always has
 *             (validate.js validateRegistration, unchanged); an open gym or a
 *             camp asks less: no player notes, no highlight link, school
 *             optional. Waiver, medical release and emergency contact always.
 *   interest  a child and a parent's contact, nothing more: no place is
 *             claimed, and no waiver or medical detail is asked for until a
 *             place is confirmed.
 *   team      a coach entering a team in a division, with the entry
 *             agreement signed.
 */

import { NAME_RE, SCHOOL_RE, EMAIL_RE, PHONE_RE } from '../validate.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const TEAM_RE = /^[A-Za-z0-9À-ÿ'&., -]{2,60}$/;

/** The form an event shows, in order. `sessions` are its active groups' names. */
export function eventFields(ev, sessions, grades) {
  const mode = ev.signup_mode;
  const gradeOptions = grades.map((g) => ({ value: g, label: g }));
  const sessionField = sessions.length > 1
    ? [{ name: 'session_time', label: mode === 'team' ? 'Division' : 'Session', type: 'radio', required: true,
      options: sessions.map((s) => ({ value: s, label: s })) }]
    : [];
  if (mode === 'team') {
    return [
      ...sessionField,
      { name: 'team_name', label: 'Team name', type: 'text', required: true, max: 60 },
      { name: 'coach_name', label: "Coach's name", type: 'text', required: true, max: 60, autocomplete: 'name' },
      { name: 'coach_email', label: "Coach's email", type: 'email', required: true, max: 254, autocomplete: 'email' },
      { name: 'coach_phone', label: "Coach's phone", type: 'tel', required: true, autocomplete: 'tel' },
      { name: 'players_count', label: 'Number of players', type: 'number', required: true, min: 1, max: 30 },
      { name: 'notes', label: 'Anything we should know', type: 'textarea', required: false, max: 500 },
      { name: 'agreement', label: 'I agree to the tournament entry agreement for this team', type: 'checkbox', required: true },
      { name: 'signature', label: "Coach's full name, as a signature", type: 'text', required: true, max: 60 },
    ];
  }
  if (mode === 'interest') {
    return [
      { name: 'player_name', label: "Player's name", type: 'text', required: true, max: 60 },
      { name: 'grade', label: 'Grade', type: 'select', required: true, options: gradeOptions },
      { name: 'parent_name', label: "Parent or guardian's name", type: 'text', required: true, max: 60, autocomplete: 'name' },
      { name: 'parent_email', label: 'Email', type: 'email', required: true, max: 254, autocomplete: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel', required: true, autocomplete: 'tel' },
      { name: 'notes', label: 'Anything we should know', type: 'textarea', required: false, max: 500 },
    ];
  }
  const evaluation = ev.kind === 'evaluation';
  return [
    ...sessionField,
    { name: 'player_name', label: "Player's name", type: 'text', required: true, max: 60 },
    { name: 'grade', label: 'Grade', type: 'select', required: true, options: gradeOptions },
    ...(evaluation ? [{ name: 'years_experience', label: 'Years playing', type: 'number', required: false, min: 0, max: 15 }] : []),
    { name: 'school', label: 'School', type: 'text', required: evaluation, max: 80 },
    { name: 'parent_name', label: "Parent or guardian's name", type: 'text', required: true, max: 60, autocomplete: 'name' },
    { name: 'parent_email', label: 'Email', type: 'email', required: true, max: 254, autocomplete: 'email' },
    { name: 'phone', label: 'Phone', type: 'tel', required: true, autocomplete: 'tel' },
    { name: 'emergency_contact_name', label: 'Emergency contact (not you)', type: 'text', required: true, max: 60 },
    { name: 'emergency_contact_phone', label: "Emergency contact's phone", type: 'tel', required: true },
    { name: 'medical_notes', label: 'Allergies or medical conditions we should know about', type: 'textarea', required: false, max: 1000 },
    ...(evaluation ? [
      { name: 'highlight_link', label: 'Highlight video link', type: 'url', required: false, max: 500 },
      { name: 'player_notes', label: 'Tell us about your player', type: 'textarea', required: true, min: 15, max: 1000 },
    ] : []),
    { name: 'assumption_of_risk', label: 'I understand basketball has risks and accept them for my child', type: 'checkbox', required: true },
    { name: 'medical_release', label: 'I authorize emergency medical care if I cannot be reached', type: 'checkbox', required: true },
    { name: 'photo_release', label: 'Tennessee Saints may use photos of my child (optional)', type: 'checkbox', required: false },
    { name: 'signature', label: "Parent or guardian's full legal name, as a signature", type: 'text', required: true, max: 60 },
  ];
}

/** "register interest". @returns {{ok: true, value: object} | {ok: false, errors: string[]}} */
export function validateInterest(body, grades) {
  const errors = [];
  const playerName = str(body.player_name);
  if (!NAME_RE.test(playerName)) errors.push('Please enter a valid player name.');
  const grade = str(body.grade);
  if (!grades.includes(grade)) errors.push(`This is for grades ${grades.join(', ')}.`);
  const parentName = str(body.parent_name);
  if (!NAME_RE.test(parentName)) errors.push('Please enter a valid parent or guardian name.');
  const parentEmail = str(body.parent_email);
  if (!EMAIL_RE.test(parentEmail) || parentEmail.length > 254) errors.push('Please enter a valid email address.');
  const phone = str(body.phone);
  if (!PHONE_RE.test(phone)) errors.push('Please enter a valid phone number.');
  const notes = str(body.notes);
  if (notes.length > 500) errors.push('Please keep the note to 500 characters.');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      player_name: playerName,
      player_name_norm: playerName.toLowerCase().replace(/\s+/g, ' '),
      grade,
      parent_name: parentName,
      parent_email: parentEmail,
      parent_email_norm: parentEmail.toLowerCase(),
      phone,
      notes: notes || null,
    },
  };
}

/** A team entry. `divisions` are the event's group names. */
export function validateTeam(body, divisions) {
  const errors = [];
  const division = divisions.length === 1 ? divisions[0] : str(body.session_time);
  if (!divisions.includes(division)) errors.push('Please choose a division.');
  const teamName = str(body.team_name).replace(/\s+/g, ' ');
  if (!TEAM_RE.test(teamName)) errors.push('Please enter the team name (2–60 letters, numbers and spaces).');
  const coachName = str(body.coach_name);
  if (!NAME_RE.test(coachName)) errors.push("Please enter the coach's name.");
  const coachEmail = str(body.coach_email);
  if (!EMAIL_RE.test(coachEmail) || coachEmail.length > 254) errors.push("Please enter the coach's email address.");
  const coachPhone = str(body.coach_phone);
  if (!PHONE_RE.test(coachPhone)) errors.push("Please enter the coach's phone number.");
  const players = Number(body.players_count);
  if (!Number.isInteger(players) || players < 1 || players > 30) errors.push('Number of players must be between 1 and 30.');
  const notes = str(body.notes);
  if (notes.length > 500) errors.push('Please keep the note to 500 characters.');
  if (body.agreement !== true) errors.push('Please agree to the tournament entry agreement.');
  const signature = str(body.signature);
  if (!NAME_RE.test(signature)) errors.push("Please type the coach's full name as a signature.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      division,
      team_name: teamName,
      team_name_norm: teamName.toLowerCase(),
      coach_name: coachName,
      coach_email: coachEmail,
      coach_email_norm: coachEmail.toLowerCase(),
      coach_phone: coachPhone,
      players_count: players,
      notes: notes || null,
      signature,
    },
  };
}

export { SCHOOL_RE };
