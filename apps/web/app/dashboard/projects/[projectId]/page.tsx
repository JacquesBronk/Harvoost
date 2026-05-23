'use client';

import { Card, EmptyState, LoadingSpinner } from '@harvoost/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch } from '@/lib/api-client.js';
import { formatHours } from '@/lib/tz.js';
import type { ProjectRollupRow } from '@/lib/api-types.js';

export default function ProjectRollupPage() {
  const params = useParams<{ projectId: string }>();
  const rollup = useQuery({
    queryKey: ['dashboard', 'project-rollup', params.projectId],
    queryFn: () =>
      apiFetch<ProjectRollupRow>(`/v1/reports/projects/${params.projectId}/rollup`),
    enabled: !!params.projectId,
  });

  return (
    <div>
      <PageHeader
        title={rollup.data?.project_name ?? 'Project'}
        description="Hours by member within this project."
      />
      {rollup.isLoading ? (
        <LoadingSpinner size="md" label="Loading rollup" />
      ) : rollup.isError ? (
        <ErrorBlock error={rollup.error} onRetry={() => rollup.refetch()} />
      ) : !rollup.data ? (
        <EmptyState title="No data" />
      ) : (
        <>
          {rollup.data.hours_budget ? (
            <Card title="Budget" className="mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-600">
                  {formatHours(rollup.data.total_hours)} of{' '}
                  {formatHours(rollup.data.hours_budget)}
                </span>
                <span className="font-mono text-xs text-neutral-500">
                  {Math.round(
                    (rollup.data.total_hours / rollup.data.hours_budget) * 100,
                  )}
                  %
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-2 bg-brand-500"
                  style={{
                    width: `${Math.min(
                      100,
                      (rollup.data.total_hours / rollup.data.hours_budget) * 100,
                    )}%`,
                  }}
                />
              </div>
            </Card>
          ) : null}

          <Card title="Members" padded={false}>
            <ul className="divide-y divide-neutral-100">
              {rollup.data.members.map((m) => (
                <li
                  key={m.user_id}
                  className="flex items-center justify-between px-4 py-2"
                >
                  <span className="font-medium text-neutral-900">{m.display_name}</span>
                  <span className="font-mono text-sm">{formatHours(m.hours)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
