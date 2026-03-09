import {
  sanitizeText,
  sanitizeAddress,
  isValidEmail,
  isValidPhone,
  formatPhone,
  isValidBirthdate,
  isValidJersey,
  isValidHeight,
  isValidWeight,
  isValidName,
} from '../lib/validation';

// ── sanitizeText ────────────────────────────────────────────────────
describe('sanitizeText', () => {
  it('strips HTML tags', () => {
    expect(sanitizeText('<b>Hello</b>')).toBe('Hello');
    expect(sanitizeText('<script>alert("x")</script>Test')).toBe('alert("x")Test');
  });

  it('trims whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeText('')).toBe('');
    expect(sanitizeText('   ')).toBe('');
  });
});

// ── sanitizeAddress ─────────────────────────────────────────────────
describe('sanitizeAddress', () => {
  it('preserves valid address characters', () => {
    expect(sanitizeAddress('123 Main St, Unit #4')).toBe('123 Main St, Unit #4');
  });

  it('strips HTML and dangerous chars', () => {
    expect(sanitizeAddress('<script>alert(1)</script>123 Elm')).toBe('alert(1)123 Elm');
  });
});

// ── isValidEmail ────────────────────────────────────────────────────
describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('test.user+tag@sub.domain.com')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('noatsign')).toBe(false);
    expect(isValidEmail('no@domain')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user @domain.com')).toBe(false);
  });
});

// ── isValidPhone ────────────────────────────────────────────────────
describe('isValidPhone', () => {
  it('accepts valid US phone numbers', () => {
    expect(isValidPhone('(615) 555-1234')).toBe(true);
    expect(isValidPhone('6155551234')).toBe(true);
    expect(isValidPhone('+1 615 555 1234')).toBe(true);
  });

  it('rejects too short or too long', () => {
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('1234567890123456')).toBe(false);
  });

  it('rejects non-phone strings', () => {
    expect(isValidPhone('abc')).toBe(false);
    expect(isValidPhone('')).toBe(false);
  });
});

// ── formatPhone ─────────────────────────────────────────────────────
describe('formatPhone', () => {
  it('formats 10-digit US numbers', () => {
    expect(formatPhone('6155551234')).toBe('(615) 555-1234');
  });

  it('formats 11-digit US numbers with leading 1', () => {
    expect(formatPhone('16155551234')).toBe('(615) 555-1234');
  });

  it('returns as-is for non-US lengths', () => {
    expect(formatPhone('+44 7911 123456')).toBe('+44 7911 123456');
  });
});

// ── isValidBirthdate ────────────────────────────────────────────────
describe('isValidBirthdate', () => {
  it('accepts valid past dates', () => {
    expect(isValidBirthdate('2010-05-15')).toBe(true);
    expect(isValidBirthdate('1990-01-01')).toBe(true);
  });

  it('rejects future dates', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const str = future.toISOString().split('T')[0];
    expect(isValidBirthdate(str)).toBe(false);
  });

  it('rejects invalid format', () => {
    expect(isValidBirthdate('05/15/2010')).toBe(false);
    expect(isValidBirthdate('2010-5-15')).toBe(false);
    expect(isValidBirthdate('')).toBe(false);
  });

  it('rejects impossible dates', () => {
    expect(isValidBirthdate('2010-02-30')).toBe(false);
    expect(isValidBirthdate('2010-13-01')).toBe(false);
  });

  it('rejects extremely old dates', () => {
    expect(isValidBirthdate('1800-01-01')).toBe(false);
  });
});

// ── isValidJersey ───────────────────────────────────────────────────
describe('isValidJersey', () => {
  it('accepts 0 through 99', () => {
    expect(isValidJersey('0')).toBe(true);
    expect(isValidJersey('23')).toBe(true);
    expect(isValidJersey('99')).toBe(true);
  });

  it('rejects out of range', () => {
    expect(isValidJersey('100')).toBe(false);
    expect(isValidJersey('-1')).toBe(false);
  });

  it('rejects non-numeric', () => {
    expect(isValidJersey('abc')).toBe(false);
    expect(isValidJersey('')).toBe(false);
  });
});

// ── isValidHeight ───────────────────────────────────────────────────
describe('isValidHeight', () => {
  it('accepts valid heights', () => {
    expect(isValidHeight("5'10\"")).toBe(true);
    expect(isValidHeight("6'2")).toBe(true);
    expect(isValidHeight("5'")).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(isValidHeight('510')).toBe(false);
    expect(isValidHeight('')).toBe(false);
    expect(isValidHeight("12'5\"")).toBe(false);
  });
});

// ── isValidWeight ───────────────────────────────────────────────────
describe('isValidWeight', () => {
  it('accepts reasonable weights', () => {
    expect(isValidWeight('150')).toBe(true);
    expect(isValidWeight('80')).toBe(true);
  });

  it('rejects zero, negative, or unreasonable', () => {
    expect(isValidWeight('0')).toBe(false);
    expect(isValidWeight('-5')).toBe(false);
    expect(isValidWeight('1500')).toBe(false);
  });

  it('rejects non-numeric', () => {
    expect(isValidWeight('abc')).toBe(false);
    expect(isValidWeight('')).toBe(false);
  });
});

// ── isValidName ─────────────────────────────────────────────────────
describe('isValidName', () => {
  it('accepts normal names', () => {
    expect(isValidName('John')).toBe(true);
    expect(isValidName("O'Brien")).toBe(true);
    expect(isValidName('Mary-Jane')).toBe(true);
    expect(isValidName('José')).toBe(true);
  });

  it('rejects empty or too long', () => {
    expect(isValidName('')).toBe(false);
    expect(isValidName('A'.repeat(51))).toBe(false);
  });

  it('rejects names with numbers or special chars', () => {
    expect(isValidName('John123')).toBe(false);
    expect(isValidName('Drop;Table')).toBe(false);
    expect(isValidName('<script>')).toBe(false);
  });
});
