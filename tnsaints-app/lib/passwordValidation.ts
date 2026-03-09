export interface PasswordCheck {
  valid: boolean;
  checks: {
    length: boolean;
    uppercase: boolean;
    lowercase: boolean;
    number: boolean;
    special: boolean;
  };
}

/**
 * Validates password strength.
 * Requires: 8+ chars, uppercase, lowercase, number, special character.
 */
export function validatePassword(password: string): PasswordCheck {
  const checks = {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password),
  };

  return {
    valid: Object.values(checks).every(Boolean),
    checks,
  };
}

export const PASSWORD_RULES = [
  { key: 'length' as const, label: 'At least 8 characters' },
  { key: 'uppercase' as const, label: 'One uppercase letter' },
  { key: 'lowercase' as const, label: 'One lowercase letter' },
  { key: 'number' as const, label: 'One number' },
  { key: 'special' as const, label: 'One special character (!@#$...)' },
];
