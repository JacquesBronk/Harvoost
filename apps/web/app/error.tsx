'use client';

import { Button, EmptyState } from '@harvoost/ui';
import { AlertOctagon } from 'lucide-react';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Unhandled application error', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <EmptyState
        icon={<AlertOctagon className="h-5 w-5" aria-hidden="true" />}
        title="Something went wrong"
        description={error.message || 'An unexpected error occurred.'}
        action={
          <Button variant="primary" onClick={() => reset()}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
