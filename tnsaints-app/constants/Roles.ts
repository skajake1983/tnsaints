export type UserRole = 'admin' | 'coach' | 'parent' | 'player';

export const Roles: Record<UserRole, { label: string; description: string }> = {
  admin: {
    label: 'Admin',
    description: 'Full program management access',
  },
  coach: {
    label: 'Coach',
    description: 'Team and event management',
  },
  parent: {
    label: 'Parent',
    description: 'View team info, RSVP, pay invoices',
  },
  player: {
    label: 'Player',
    description: 'View schedule, roster, and stats',
  },
};
