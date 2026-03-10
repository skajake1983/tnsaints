import { hasPermission, hasAllPermissions, hasAnyPermission, getPermissions, Permission } from '../lib/permissions';
import { UserRole } from '../constants/Roles';

describe('permissions – hasPermission', () => {
  // ── Default-deny ────────────────────────────────────────────────
  it('returns false for null/undefined role', () => {
    expect(hasPermission(null, 'roster.view')).toBe(false);
    expect(hasPermission(undefined, 'roster.view')).toBe(false);
  });

  it('returns false for unknown role', () => {
    expect(hasPermission('unknown' as UserRole, 'roster.view')).toBe(false);
  });

  // ── Super Admin (has everything) ────────────────────────────────
  it('superadmin has all permissions', () => {
    const all: Permission[] = [
      'team.create', 'team.delete', 'team.edit', 'team.viewAll', 'team.viewAssigned',
      'roster.add', 'roster.edit', 'roster.remove', 'roster.view', 'roster.invite',
      'event.create', 'event.edit', 'event.delete', 'event.view',
      'availability.markOwn', 'availability.viewTeam',
      'chat.send', 'chat.editOwn', 'chat.deleteOwn', 'chat.createChannel', 'chat.deleteAny',
      'file.upload', 'file.view', 'file.deleteOwn', 'file.deleteAny',
      'stats.enter', 'stats.viewTeam', 'stats.viewOwn', 'stats.viewCoachRecord',
      'invoice.create', 'invoice.viewAll', 'invoice.viewOwn', 'invoice.pay',
      'alert.send', 'alert.receive',
      'user.changeRole', 'user.promoteAdmin', 'user.assignTeam', 'user.editOwnProfile',
    ];
    for (const p of all) {
      expect(hasPermission('superadmin', p)).toBe(true);
    }
  });

  // ── Admin (team-scoped, no create/delete team, no viewAll, no promoteAdmin) ──
  it('admin cannot create or delete teams', () => {
    expect(hasPermission('admin', 'team.create')).toBe(false);
    expect(hasPermission('admin', 'team.delete')).toBe(false);
  });

  it('admin cannot view all teams', () => {
    expect(hasPermission('admin', 'team.viewAll')).toBe(false);
  });

  it('admin cannot promote to admin', () => {
    expect(hasPermission('admin', 'user.promoteAdmin')).toBe(false);
  });

  it('admin can edit team and manage roster', () => {
    expect(hasPermission('admin', 'team.edit')).toBe(true);
    expect(hasPermission('admin', 'roster.add')).toBe(true);
    expect(hasPermission('admin', 'roster.edit')).toBe(true);
    expect(hasPermission('admin', 'roster.remove')).toBe(true);
    expect(hasPermission('admin', 'roster.invite')).toBe(true);
  });

  it('admin can manage invoicing', () => {
    expect(hasPermission('admin', 'invoice.create')).toBe(true);
    expect(hasPermission('admin', 'invoice.viewAll')).toBe(true);
    expect(hasPermission('admin', 'invoice.pay')).toBe(true);
  });

  it('admin can delete any message', () => {
    expect(hasPermission('admin', 'chat.deleteAny')).toBe(true);
  });

  it('admin can edit and delete own messages', () => {
    expect(hasPermission('admin', 'chat.editOwn')).toBe(true);
    expect(hasPermission('admin', 'chat.deleteOwn')).toBe(true);
  });

  // ── Coach ───────────────────────────────────────────────────────
  it('coach can manage roster and events', () => {
    expect(hasPermission('coach', 'roster.add')).toBe(true);
    expect(hasPermission('coach', 'roster.edit')).toBe(true);
    expect(hasPermission('coach', 'event.create')).toBe(true);
    expect(hasPermission('coach', 'event.delete')).toBe(true);
    expect(hasPermission('coach', 'stats.enter')).toBe(true);
    expect(hasPermission('coach', 'alert.send')).toBe(true);
  });

  it('coach cannot manage invoicing', () => {
    expect(hasPermission('coach', 'invoice.create')).toBe(false);
    expect(hasPermission('coach', 'invoice.viewAll')).toBe(false);
    expect(hasPermission('coach', 'invoice.pay')).toBe(false);
  });

  it('coach cannot view own coach record', () => {
    expect(hasPermission('coach', 'stats.viewCoachRecord')).toBe(false);
    expect(hasPermission('coach', 'stats.viewOwn')).toBe(false);
  });

  it('only superadmin can view coach record', () => {
    expect(hasPermission('superadmin', 'stats.viewCoachRecord')).toBe(true);
    expect(hasPermission('admin', 'stats.viewCoachRecord')).toBe(false);
    expect(hasPermission('coach', 'stats.viewCoachRecord')).toBe(false);
    expect(hasPermission('parent', 'stats.viewCoachRecord')).toBe(false);
    expect(hasPermission('player', 'stats.viewCoachRecord')).toBe(false);
  });

  it('coach cannot delete any message', () => {
    expect(hasPermission('coach', 'chat.deleteAny')).toBe(false);
  });

  it('coach can edit and delete own messages', () => {
    expect(hasPermission('coach', 'chat.editOwn')).toBe(true);
    expect(hasPermission('coach', 'chat.deleteOwn')).toBe(true);
  });

  it('coach cannot change roles or manage teams', () => {
    expect(hasPermission('coach', 'user.changeRole')).toBe(false);
    expect(hasPermission('coach', 'team.edit')).toBe(false);
    expect(hasPermission('coach', 'team.create')).toBe(false);
  });

  it('coach can upload and delete own files', () => {
    expect(hasPermission('coach', 'file.upload')).toBe(true);
    expect(hasPermission('coach', 'file.deleteOwn')).toBe(true);
    expect(hasPermission('coach', 'file.deleteAny')).toBe(false);
  });

  // ── Parent ──────────────────────────────────────────────────────
  it('parent can view roster and schedule', () => {
    expect(hasPermission('parent', 'roster.view')).toBe(true);
    expect(hasPermission('parent', 'event.view')).toBe(true);
    expect(hasPermission('parent', 'team.viewAssigned')).toBe(true);
  });

  it('parent cannot modify roster or events', () => {
    expect(hasPermission('parent', 'roster.add')).toBe(false);
    expect(hasPermission('parent', 'roster.edit')).toBe(false);
    expect(hasPermission('parent', 'event.create')).toBe(false);
    expect(hasPermission('parent', 'event.delete')).toBe(false);
  });

  it('parent can chat and mark availability', () => {
    expect(hasPermission('parent', 'chat.send')).toBe(true);
    expect(hasPermission('parent', 'availability.markOwn')).toBe(true);
  });

  it('parent can edit and delete own messages', () => {
    expect(hasPermission('parent', 'chat.editOwn')).toBe(true);
    expect(hasPermission('parent', 'chat.deleteOwn')).toBe(true);
    expect(hasPermission('parent', 'chat.deleteAny')).toBe(false);
  });

  it('parent cannot see team availability summary', () => {
    expect(hasPermission('parent', 'availability.viewTeam')).toBe(false);
  });

  it('parent can view and pay own invoices', () => {
    expect(hasPermission('parent', 'invoice.viewOwn')).toBe(true);
    expect(hasPermission('parent', 'invoice.pay')).toBe(true);
    expect(hasPermission('parent', 'invoice.create')).toBe(false);
    expect(hasPermission('parent', 'invoice.viewAll')).toBe(false);
  });

  it('parent has no stats permissions', () => {
    expect(hasPermission('parent', 'stats.viewOwn')).toBe(false);
    expect(hasPermission('parent', 'stats.viewTeam')).toBe(false);
    expect(hasPermission('parent', 'stats.enter')).toBe(false);
    expect(hasPermission('parent', 'stats.viewCoachRecord')).toBe(false);
  });

  it('parent cannot upload files or send alerts', () => {
    expect(hasPermission('parent', 'file.upload')).toBe(false);
    expect(hasPermission('parent', 'alert.send')).toBe(false);
  });

  // ── Player ──────────────────────────────────────────────────────
  it('player can view roster, schedule, and own stats', () => {
    expect(hasPermission('player', 'roster.view')).toBe(true);
    expect(hasPermission('player', 'event.view')).toBe(true);
    expect(hasPermission('player', 'stats.viewOwn')).toBe(true);
  });

  it('player can chat and mark availability', () => {
    expect(hasPermission('player', 'chat.send')).toBe(true);
    expect(hasPermission('player', 'availability.markOwn')).toBe(true);
  });

  it('player can edit and delete own messages', () => {
    expect(hasPermission('player', 'chat.editOwn')).toBe(true);
    expect(hasPermission('player', 'chat.deleteOwn')).toBe(true);
    expect(hasPermission('player', 'chat.deleteAny')).toBe(false);
  });

  it('player cannot modify anything', () => {
    expect(hasPermission('player', 'roster.add')).toBe(false);
    expect(hasPermission('player', 'event.create')).toBe(false);
    expect(hasPermission('player', 'stats.enter')).toBe(false);
    expect(hasPermission('player', 'file.upload')).toBe(false);
    expect(hasPermission('player', 'alert.send')).toBe(false);
    expect(hasPermission('player', 'invoice.create')).toBe(false);
    expect(hasPermission('player', 'invoice.pay')).toBe(false);
  });

  it('player cannot access invoice features', () => {
    expect(hasPermission('player', 'invoice.viewOwn')).toBe(false);
    expect(hasPermission('player', 'invoice.viewAll')).toBe(false);
    expect(hasPermission('player', 'invoice.pay')).toBe(false);
  });
});

describe('permissions – hasAllPermissions', () => {
  it('returns true when role has all listed permissions', () => {
    expect(hasAllPermissions('coach', ['roster.add', 'roster.edit', 'event.create'])).toBe(true);
  });

  it('returns false when role is missing one', () => {
    expect(hasAllPermissions('coach', ['roster.add', 'invoice.create'])).toBe(false);
  });

  it('returns true for empty array', () => {
    expect(hasAllPermissions('player', [])).toBe(true);
  });
});

describe('permissions – hasAnyPermission', () => {
  it('returns true when role has at least one', () => {
    expect(hasAnyPermission('parent', ['roster.add', 'roster.view'])).toBe(true);
  });

  it('returns false when role has none', () => {
    expect(hasAnyPermission('player', ['invoice.create', 'team.create'])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasAnyPermission('player', [])).toBe(false);
  });
});

describe('permissions – getPermissions', () => {
  it('returns a non-empty set for valid roles', () => {
    const roles: UserRole[] = ['superadmin', 'admin', 'coach', 'parent', 'player'];
    for (const role of roles) {
      expect(getPermissions(role).size).toBeGreaterThan(0);
    }
  });

  it('superadmin has the most permissions', () => {
    const sa = getPermissions('superadmin').size;
    const admin = getPermissions('admin').size;
    const coach = getPermissions('coach').size;
    const parent = getPermissions('parent').size;
    const player = getPermissions('player').size;
    expect(sa).toBeGreaterThanOrEqual(admin);
    expect(admin).toBeGreaterThanOrEqual(coach);
    expect(coach).toBeGreaterThanOrEqual(parent);
    expect(parent).toBeGreaterThanOrEqual(player);
  });
});
