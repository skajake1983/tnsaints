/**
 * Input validation & sanitization helpers for the roster form.
 * Strips potentially dangerous characters and validates data shapes.
 */

/** Strip HTML tags and trim whitespace */
export function sanitizeText(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim();
}

/** Validate email format */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Validate phone — digits, spaces, dashes, parens, plus sign; 7–15 digits total */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 && /^[0-9()\-+.\s]+$/.test(phone);
}

/** Format phone to (XXX) XXX-XXXX for US numbers */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone; // return as-is for non-US numbers
}

/** Validate ISO date string (YYYY-MM-DD) and ensure it's a real date in the past */
export function isValidBirthdate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(dateStr + 'T00:00:00');
  if (isNaN(date.getTime())) return false;
  // Must be in the past
  if (date >= new Date()) return false;
  // Reasonable range: no older than 120, no younger than 0
  const year = date.getFullYear();
  const currentYear = new Date().getFullYear();
  if (year < currentYear - 120 || year > currentYear) return false;
  // Verify the parsed date matches input (catches Feb 30 etc.)
  const [y, m, d] = dateStr.split('-').map(Number);
  return date.getFullYear() === y && date.getMonth() + 1 === m && date.getDate() === d;
}

/** Validate jersey number (0–99) */
export function isValidJersey(value: string): boolean {
  const num = parseInt(value, 10);
  return !isNaN(num) && num >= 0 && num <= 99 && String(num) === value.replace(/^0+(?=\d)/, '');
}

/** Validate height format: digits'digits" e.g. 5'10" or 6'2 */
export function isValidHeight(value: string): boolean {
  return /^\d{1}'(\d{1,2}"?)?$/.test(value);
}

/** Validate weight (positive integer, reasonable range) */
export function isValidWeight(value: string): boolean {
  const num = parseInt(value, 10);
  return !isNaN(num) && num > 0 && num < 1000;
}

/** Validate name: letters, spaces, hyphens, apostrophes only, 1–50 chars */
export function isValidName(value: string): boolean {
  const sanitized = sanitizeText(value);
  return sanitized.length >= 1 && sanitized.length <= 50 && /^[a-zA-ZÀ-ÿ'\-\s]+$/.test(sanitized);
}

/** Sanitize address — strip anything suspicious, keep alphanumeric + common address chars */
export function sanitizeAddress(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/[^\w\s,.\-#'/()]/g, '').trim();
}
