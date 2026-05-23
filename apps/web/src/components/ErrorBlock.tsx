import { AlertCircle } from 'lucide-react';
import { Button } from '@harvoost/ui';
import { describeError } from '@/lib/api-client.js';

export function ErrorBlock({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-md border border-danger-500/30 bg-danger-50 px-4 py-3 text-sm text-danger-700"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <span className="font-medium">Could not load data</span>
      </div>
      <p>{describeError(error)}</p>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
