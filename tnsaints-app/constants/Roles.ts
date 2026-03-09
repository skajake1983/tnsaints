export type UserRole = 'superadmin' | 'admin' | 'coach' | 'parent' | 'player';

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  superadmin: 0,
  admin: 1,
  coach: 2,
  parent: 3,
  player: 4,
};

export const Roles: Record<UserRole, { label: string; description: string }> = {
  superadmin: {
    label: 'Super Admin',
    description: 'Organisation-wide access across all teams',
  },
  admin: {
    label: 'Admin',
    description: 'Full management access within assigned teams',
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
