import Link from 'next/link';
import { Button, EmptyState } from '@harvoost/ui';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <EmptyState
        title="Page not found"
        description="The page you were looking for doesn't exist or you don't have permission to view it."
        action={
          <Link href="/timesheets">
            <Button variant="primary">Go to timesheets</Button>
          </Link>
        }
      />
    </div>
  );
}
