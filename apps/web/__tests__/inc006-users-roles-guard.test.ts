import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RolesCell, rolesOf, roleSet } from '../app/admin/users/roles-cell.js';
import type { Role, User } from '../src/lib/api-types.js';

/**
 * INC-006 (GitHub #7) — Admin › Users page crashed into the React error
 * boundary on load: the page mapped over `user.roles` UNGUARDED while
 * `GET /v1/users` omitted the field, so `user.roles.length` threw
 * "Cannot read properties of undefined (reading 'length')".
 *
 * The backend lane now returns `roles: string[]` per user (matching
 * `GET /v1/auth/me`). These tests pin the defense-in-depth so the role-render
 * path NEVER crashes — it degrades to "No roles" when the field is missing,
 * renders the chips when present, and seeds the role editor consistently.
 *
 * Node-env `renderToStaticMarkup`, mirroring apps/web/__tests__/avatar.test.ts.
 */

/** A user object with a guaranteed-present roles array. */
function userWith(roles: Role[]): User {
  return {
    id: 'usr_1',
    email: 'ada@example.com',
    display_name: 'Ada Lovelace',
    roles,
    timezone: 'UTC',
    weekly_summary_opt_out: false,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** A user whose `roles` field is absent (the drifted `GET /v1/users` row). */
function userWithoutRoles(): User {
  const u = userWith([]) as Partial<User>;
  delete u.roles;
  return u as User;
}

describe('rolesOf — normalizes a possibly-absent roles field', () => {
  it('returns the array unchanged when present', () => {
    expect(rolesOf(userWith(['admin', 'manager']))).toEqual(['admin', 'manager']);
  });

  it('returns [] for an empty roles array', () => {
    expect(rolesOf(userWith([]))).toEqual([]);
  });

  it('returns [] when roles is undefined (the crash case)', () => {
    expect(rolesOf(userWithoutRoles())).toEqual([]);
  });

  it('never throws regardless of the roles field', () => {
    expect(() => rolesOf(userWithoutRoles())).not.toThrow();
    expect(() => rolesOf(userWith([]))).not.toThrow();
    expect(() => rolesOf(userWith(['employee']))).not.toThrow();
  });
});

describe('roleSet — seeds the role editor draft from a user', () => {
  it('seeds the Set from present roles', () => {
    const set = roleSet(userWith(['admin', 'finmgr']));
    expect(set.has('admin')).toBe(true);
    expect(set.has('finmgr')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('seeds an empty Set when roles are absent (no crash)', () => {
    const set = roleSet(userWithoutRoles());
    expect(set.size).toBe(0);
  });

  it('seeds an empty Set for an explicit empty roles array', () => {
    expect(roleSet(userWith([])).size).toBe(0);
  });
});

describe('RolesCell — defensive role rendering (INC-006)', () => {
  it('does NOT throw when roles is missing — renders "No roles"', () => {
    const html = renderToStaticMarkup(
      createElement(RolesCell, { user: userWithoutRoles() }),
    );
    expect(html).toContain('No roles');
  });

  it('renders "No roles" for an explicit empty array', () => {
    const html = renderToStaticMarkup(
      createElement(RolesCell, { user: userWith([]) }),
    );
    expect(html).toContain('No roles');
  });

  it('renders a chip per role when roles are present', () => {
    const html = renderToStaticMarkup(
      createElement(RolesCell, { user: userWith(['admin', 'employee']) }),
    );
    expect(html).toContain('admin');
    expect(html).toContain('employee');
    // The empty-state placeholder must NOT appear when roles exist.
    expect(html).not.toContain('No roles');
  });

  it('never throws for any roles shape (present, empty, or absent)', () => {
    for (const make of [
      () => userWith(['admin', 'finmgr', 'manager', 'employee']),
      () => userWith([]),
      () => userWithoutRoles(),
    ]) {
      expect(() =>
        renderToStaticMarkup(createElement(RolesCell, { user: make() })),
      ).not.toThrow();
    }
  });
});
