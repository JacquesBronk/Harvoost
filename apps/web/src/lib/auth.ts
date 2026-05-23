'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from './api-client.js';

// Shape returned by GET /v1/auth/me.
// Keep this loose until we wire openapi-typescript-generated types.
export interface CurrentUser {
  id: string;
  email: string;
  display_name: string;
  timezone: string;
  roles: Array<'admin' | 'finmgr' | 'manager' | 'employee'>;
  scope_summary?: {
    visible_users_count: number; // -1 = unrestricted
    visible_projects_count: number; // -1 = unrestricted
  };
}

export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await apiFetch<CurrentUser>('/v1/auth/me');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function hasRole(
  user: CurrentUser | null | undefined,
  ...roles: CurrentUser['roles']
): boolean {
  if (!user) return false;
  return roles.some((r) => user.roles.includes(r));
}

export function isAdmin(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin');
}

export function isFinMgr(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'finmgr');
}

export function isManager(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'manager');
}

export function canSeeFinancialData(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'finmgr');
}

export function canApproveStage1(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'manager');
}

export function canApproveStage2(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'finmgr');
}
