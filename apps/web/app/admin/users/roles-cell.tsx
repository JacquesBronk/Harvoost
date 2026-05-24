import { Badge } from '@harvoost/ui';
import type { Role, User } from '@/lib/api-types.js';

/**
 * INC-006 — defensive role rendering for the Admin › Users table.
 *
 * The backend `GET /v1/users` list returns `roles: string[]` per user (same
 * shape as `GET /v1/auth/me`). These helpers render that correctly AND survive
 * its absence: the page previously read `user.roles.length` / `user.roles.map`
 * unguarded, so a missing field threw "Cannot read properties of undefined
 * (reading 'length')" and crashed the whole route into the error boundary.
 *
 * The guard is belt-and-suspenders: even after the backend fix always returns
 * `roles`, a single drifted row degrades to "No roles" instead of a hard crash.
 */

/** Normalize a (possibly absent) `roles` field to an always-array. */
export function rolesOf(user: Pick<User, 'roles'>): Role[] {
  return user.roles ?? [];
}

/** Seed a draft Set from a user's roles, tolerating an absent field. */
export function roleSet(user: Pick<User, 'roles'>): Set<Role> {
  return new Set(rolesOf(user));
}

/**
 * The "Roles" table cell body: a "No roles" placeholder when empty/absent, or a
 * Badge chip per role. Behavior is identical to the prior inline JSX when
 * `roles` is present.
 */
export function RolesCell({ user }: { user: Pick<User, 'roles'> }) {
  const roles = rolesOf(user);
  return (
    <div className="flex flex-wrap gap-1">
      {roles.length === 0 ? (
        <span className="text-xs text-neutral-400">No roles</span>
      ) : (
        roles.map((r) => (
          <Badge key={r} tone="neutral" className="capitalize">
            {r}
          </Badge>
        ))
      )}
    </div>
  );
}
