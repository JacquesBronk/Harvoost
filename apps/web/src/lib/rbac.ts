'use client';

import { useCurrentUser } from './auth.js';

// Convenience hook for role-aware UI components.
export function useScope() {
  const { data: user, isLoading, isError } = useCurrentUser();
  return {
    user,
    isLoading,
    isError,
    isAuthed: !!user,
    roles: user?.roles ?? [],
    canSeeFinancialData:
      !!user && (user.roles.includes('admin') || user.roles.includes('finmgr')),
    canApproveStage1:
      !!user && (user.roles.includes('admin') || user.roles.includes('manager')),
    canApproveStage2:
      !!user && (user.roles.includes('admin') || user.roles.includes('finmgr')),
    isAdmin: !!user && user.roles.includes('admin'),
  };
}
