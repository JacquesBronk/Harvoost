'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LoadingSpinner } from '@harvoost/ui';
import { resolveAuthGate, useCurrentUser } from '@/lib/auth.js';

export default function HomePage() {
  const router = useRouter();
  const { data: user, isLoading, isError } = useCurrentUser();

  useEffect(() => {
    // INC-003: redirect ONLY on a genuine null (401/403). While loading OR in a
    // transient error state (429/5xx/network), stay on the spinner and let the
    // auth query back off and recover — never redirect, or we trigger the
    // remount → refetch storm.
    const decision = resolveAuthGate({ user, isLoading, isError });
    if (decision.kind === 'wait') return;
    if (decision.kind === 'login') {
      router.replace('/login');
    } else {
      router.replace('/timesheets');
    }
  }, [user, isLoading, isError, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingSpinner size="lg" label="Loading Harvoost" />
    </div>
  );
}
