/**
 * Validation for the family forms. Server-side and authoritative: the browser
 * gets `required` and input types for convenience, but nothing it sends is
 * trusted.
 *
 * Each validator returns { values, errors } where errors is a list of
 * { id, message } — the id is the field's id, so the error summary can link
 * straight to it and the field can mark itself invalid.
 */

import { PHONE_RE } from '../validate.js';
import { ageOn, schoolYearOf } from '../lib/grades.js';

export const SHIRT_SIZES = [
  ['YXS', 'Youth XS'], ['YS', 'Youth S'], ['YM', 'Youth M'], ['YL', 'Youth L'], ['YXL', 'Youth XL'],
  ['AS', 'Adult S'], ['AM', 'Adult M'], ['AL', 'Adult L'], ['AXL', 'Adult XL'], ['A2XL', 'Adult 2XL'],
];
export const RELATIONSHIPS = ['Mother', 'Father', 'Guardian', 'Grandparent', 'Other family member'];
const MIN_AGE = 4;
const MAX_AGE = 19;

const text = (form, key, max) => String(form.get(key) || '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

function requireText(form, key, label, max, errors) {
  const value = text(form, key, max);
  if (!value) errors.push({ id: key, message: `Enter ${label}` });
  else if (value.length > max) errors.push({ id: key, message: `${label[0].toUpperCase()}${label.slice(1)} must be ${max} characters or fewer` });
  return value.slice(0, max);
}

function requirePhone(form, key, label, errors) {
  const value = text(form, key, 30);
  if (!value) errors.push({ id: key, message: `Enter ${label}` });
  else if (!PHONE_RE.test(value)) errors.push({ id: key, message: `Enter ${label} like (615) 555-0100` });
  return value;
}

function requireChoice(form, key, allowed, message, errors) {
  const value = String(form.get(key) || '');
  if (!allowed.includes(value)) errors.push({ id: key, message });
  return value;
}

/** The guardian's own details, on family setup and profile edit. */
export function validateGuardian(form) {
  const errors = [];
  const values = {
    guardianName: requireText(form, 'guardian_name', 'your full name', 80, errors),
    phone: requirePhone(form, 'phone', 'your mobile number', errors),
    relationship: requireChoice(form, 'relationship', RELATIONSHIPS, 'Choose your relationship to the children', errors),
    displayName: text(form, 'family_name', 80).slice(0, 80),
  };
  if (!values.displayName && values.guardianName) {
    const surname = values.guardianName.split(' ').slice(-1)[0];
    values.displayName = `The ${surname} family`;
  }
  return { values, errors };
}

/** A child's profile. Everything the academy needs before an application. */
export function validateChild(form, now = new Date()) {
  const errors = [];
  const name = requireText(form, 'child_name', "the child's full name", 60, errors);
  const dateOfBirth = String(form.get('date_of_birth') || '').trim();
  const age = ageOn(dateOfBirth, now);
  if (!dateOfBirth) errors.push({ id: 'date_of_birth', message: 'Enter a date of birth' });
  else if (age === null) errors.push({ id: 'date_of_birth', message: 'Enter the date of birth as a real date' });
  else if (age < MIN_AGE || age > MAX_AGE) {
    errors.push({ id: 'date_of_birth', message: `Date of birth must be for a child aged ${MIN_AGE} to ${MAX_AGE}` });
  }
  const gradeRaw = String(form.get('grade') || '');
  const gradeLevel = /^(?:[0-9]|1[0-2])$/.test(gradeRaw) ? Number(gradeRaw) : null;
  if (gradeLevel === null) errors.push({ id: 'grade', message: 'Choose the grade they are in now' });
  const school = requireText(form, 'school', 'their school', 100, errors);
  const shirtSize = requireChoice(form, 'shirt_size', SHIRT_SIZES.map(([v]) => v), 'Choose a shirt size', errors);
  return {
    errors,
    values: {
      name,
      nameNorm: name.toLowerCase().replace(/\s+/g, ' '),
      dateOfBirth,
      gradeLevel,
      gradeSchoolYear: schoolYearOf(now),
      school,
      shirtSize,
    },
  };
}

/** Medical: an affirmative "nothing to declare", or the details. */
export function validateMedical(form) {
  const errors = [];
  const status = requireChoice(form, 'medical_status', ['none_declared', 'declared'],
    'Choose whether there is anything we should know', errors);
  const notes = String(form.get('medical_notes') || '').trim().slice(0, 2001);
  if (status === 'declared' && !notes) {
    errors.push({ id: 'medical_notes', message: 'Describe the allergy, condition or medication' });
  } else if (notes.length > 2000) {
    errors.push({ id: 'medical_notes', message: 'Keep medical details to 2,000 characters or fewer' });
  }
  return { errors, values: { status, notes: status === 'declared' ? notes.slice(0, 2000) : null } };
}

/**
 * Up to three emergency contacts, in the order to call them. Blank rows are
 * skipped; a half-filled row is an error; at least one complete row is required.
 */
export function validateContacts(form) {
  const errors = [];
  const contacts = [];
  for (let i = 1; i <= 3; i += 1) {
    const name = text(form, `ec${i}_name`, 80);
    const phone = text(form, `ec${i}_phone`, 30);
    const relationship = text(form, `ec${i}_relationship`, 40).slice(0, 40);
    if (!name && !phone && !relationship) continue;
    if (!name) errors.push({ id: `ec${i}_name`, message: `Enter a name for contact ${i}` });
    if (!phone) errors.push({ id: `ec${i}_phone`, message: `Enter a phone number for contact ${i}` });
    else if (!PHONE_RE.test(phone)) errors.push({ id: `ec${i}_phone`, message: `Enter contact ${i}'s phone like (615) 555-0100` });
    contacts.push({ name: name.slice(0, 80), phone, relationship: relationship || null });
  }
  if (!contacts.length) errors.push({ id: 'ec1_name', message: 'Add at least one emergency contact' });
  return { errors, values: contacts };
}
