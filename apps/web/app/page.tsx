'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LoadingSpinner } from '@harvoost/ui';
import { useCurrentUser } from '@/lib/auth.js';

export default function HomePage() {
  const router = useRouter();
  const { data: user, isLoading } = useCurrentUser();

  useEffect(() => {
    if (isLoading) return;
    if (user) {
      router.replace('/timesheets');
    } else {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingSpinner size="lg" label="Loading Harvoost" />
    </div>
  );
}
