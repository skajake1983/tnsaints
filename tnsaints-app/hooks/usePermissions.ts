import { useAuthStore } from '../stores/authStore';
import { hasPermission, hasAnyPermission, hasAllPermissions, Permission } from '../lib/permissions';

/**
 * Hook that provides permission checks against the current user's role.
 *
 * Usage:
 *   const { can, canAny, canAll } = usePermissions();
 *   if (can('roster.add')) { ... }
 */
export function usePermissions() {
  const role = useAuthStore((s) => s.profile?.role);

  return {
    role,
    can: (permission: Permission) => hasPermission(role, permission),
    canAny: (permissions: Permission[]) => hasAnyPermission(role, permissions),
    canAll: (permissions: Permission[]) => hasAllPermissions(role, permissions),
  };
}
