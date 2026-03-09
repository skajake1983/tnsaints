/**
 * Centralised RBAC permission system.
 *
 * Every feature guard in the app — UI visibility, Firestore rules,
 * and eventually Cloud Function checks — should reference this matrix.
 *
 * Security-by-design: default-deny. A role only has access if
 * explicitly granted here.
 */

import { UserRole } from '../constants/Roles';

// ── Permission action keys ──────────────────────────────────────────

export type Permission =
  // Team management
  | 'team.create'
  | 'team.delete'
  | 'team.edit'
  | 'team.viewAll'        // see every team in the org
  | 'team.viewAssigned'   // see own assigned teams

  // Roster
  | 'roster.add'
  | 'roster.edit'
  | 'roster.remove'
  | 'roster.view'
  | 'roster.invite'       // send invites to parents/coaches

  // Schedule / Events
  | 'event.create'
  | 'event.edit'
  | 'event.delete'
  | 'event.view'

  // Availability
  | 'availability.markOwn'
  | 'availability.viewTeam'

  // Chat
  | 'chat.send'
  | 'chat.createChannel'
  | 'chat.deleteAny'

  // File Sharing
  | 'file.upload'
  | 'file.view'
  | 'file.deleteOwn'
  | 'file.deleteAny'

  // Stats
  | 'stats.enter'
  | 'stats.viewTeam'
  | 'stats.viewOwn'

  // Invoicing
  | 'invoice.create'
  | 'invoice.viewAll'
  | 'invoice.viewOwn'
  | 'invoice.pay'

  // Alerts / Reminders
  | 'alert.send'
  | 'alert.receive'

  // User Management
  | 'user.changeRole'
  | 'user.promoteAdmin'
  | 'user.assignTeam'
  | 'user.editOwnProfile';

// ── Permission matrix ───────────────────────────────────────────────

const PERMISSION_MATRIX: Record<UserRole, ReadonlySet<Permission>> = {
  superadmin: new Set<Permission>([
    // Team
    'team.create', 'team.delete', 'team.edit', 'team.viewAll', 'team.viewAssigned',
    // Roster
    'roster.add', 'roster.edit', 'roster.remove', 'roster.view', 'roster.invite',
    // Events
    'event.create', 'event.edit', 'event.delete', 'event.view',
    // Availability
    'availability.markOwn', 'availability.viewTeam',
    // Chat
    'chat.send', 'chat.createChannel', 'chat.deleteAny',
    // Files
    'file.upload', 'file.view', 'file.deleteOwn', 'file.deleteAny',
    // Stats
    'stats.enter', 'stats.viewTeam', 'stats.viewOwn',
    // Invoicing
    'invoice.create', 'invoice.viewAll', 'invoice.viewOwn', 'invoice.pay',
    // Alerts
    'alert.send', 'alert.receive',
    // User management
    'user.changeRole', 'user.promoteAdmin', 'user.assignTeam', 'user.editOwnProfile',
  ]),

  admin: new Set<Permission>([
    // Team (scoped to assigned teams — no create/delete/viewAll)
    'team.edit', 'team.viewAssigned',
    // Roster
    'roster.add', 'roster.edit', 'roster.remove', 'roster.view', 'roster.invite',
    // Events
    'event.create', 'event.edit', 'event.delete', 'event.view',
    // Availability
    'availability.markOwn', 'availability.viewTeam',
    // Chat
    'chat.send', 'chat.createChannel', 'chat.deleteAny',
    // Files
    'file.upload', 'file.view', 'file.deleteOwn', 'file.deleteAny',
    // Stats
    'stats.enter', 'stats.viewTeam', 'stats.viewOwn',
    // Invoicing
    'invoice.create', 'invoice.viewAll', 'invoice.viewOwn', 'invoice.pay',
    // Alerts
    'alert.send', 'alert.receive',
    // User management (within own team, cannot promote to admin)
    'user.changeRole', 'user.assignTeam', 'user.editOwnProfile',
  ]),

  coach: new Set<Permission>([
    'team.viewAssigned',
    // Roster
    'roster.add', 'roster.edit', 'roster.remove', 'roster.view', 'roster.invite',
    // Events
    'event.create', 'event.edit', 'event.delete', 'event.view',
    // Availability
    'availability.markOwn', 'availability.viewTeam',
    // Chat
    'chat.send', 'chat.createChannel',
    // Files
    'file.upload', 'file.view', 'file.deleteOwn',
    // Stats
    'stats.enter', 'stats.viewTeam', 'stats.viewOwn',
    // Alerts
    'alert.send', 'alert.receive',
    // Profile
    'user.editOwnProfile',
  ]),

  parent: new Set<Permission>([
    'team.viewAssigned',
    'roster.view',
    'event.view',
    'availability.markOwn',   // for their child
    'chat.send',
    'file.view',
    'stats.viewOwn',          // own child's stats
    'invoice.viewOwn', 'invoice.pay',
    'alert.receive',
    'user.editOwnProfile',
  ]),

  player: new Set<Permission>([
    'team.viewAssigned',
    'roster.view',
    'event.view',
    'availability.markOwn',
    'chat.send',
    'file.view',
    'stats.viewOwn',
    'alert.receive',
    'user.editOwnProfile',
  ]),
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check whether a role has a specific permission.
 * Default-deny: returns false for unknown roles or permissions.
 */
export function hasPermission(role: UserRole | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  const perms = PERMISSION_MATRIX[role];
  if (!perms) return false;
  return perms.has(permission);
}

/**
 * Check whether a role has ALL of the listed permissions.
 */
export function hasAllPermissions(role: UserRole | undefined | null, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Check whether a role has ANY of the listed permissions.
 */
export function hasAnyPermission(role: UserRole | undefined | null, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/**
 * Return the full set of permissions for a role (for debugging / admin UI).
 */
export function getPermissions(role: UserRole): ReadonlySet<Permission> {
  return PERMISSION_MATRIX[role] ?? new Set();
}
