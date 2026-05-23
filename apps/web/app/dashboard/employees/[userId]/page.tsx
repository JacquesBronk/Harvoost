'use client';

import { Card, EmptyState, LoadingSpinner } from '@harvoost/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch } from '@/lib/api-client.js';
import { formatHours } from '@/lib/tz.js';

interface EmployeeDrillIn {
  user_id: string;
  display_name: string;
  per_project: Array<{ project_id: string; project_name: string; hours: number }>;
  out_of_scope_project_count: number;
  out_of_scope_hours: number;
}

export default function EmployeeDrillPage() {
  const params = useParams<{ userId: string }>();
  const drill = useQuery({
    queryKey: ['dashboard', 'employee', params.userId],
    queryFn: () =>
      apiFetch<EmployeeDrillIn>(`/v1/reports/employees/${params.userId}/rollup`),
    enabled: !!params.userId,
  });

  return (
    <div>
      <PageHeader
        title={drill.data?.display_name ?? 'Employee'}
        description="Hours by project within your visible scope."
      />
      {drill.isLoading ? (
        <LoadingSpinner size="md" label="Loading employee data" />
      ) : drill.isError ? (
        <ErrorBlock error={drill.error} onRetry={() => drill.refetch()} />
      ) : !drill.data ? (
        <EmptyState title="No data" />
      ) : (
        <Card title="Per project" padded={false}>
          <ul className="divide-y divide-neutral-100">
            {drill.data.per_project.map((p) => (
              <li
                key={p.project_id}
                className="flex items-center justify-between px-4 py-2"
              >
                <span className="font-medium text-neutral-900">{p.project_name}</span>
                <span className="font-mono text-sm">{formatHours(p.hours)}</span>
              </li>
            ))}
            {drill.data.out_of_scope_project_count > 0 ? (
              <li className="flex items-center justify-between bg-neutral-50/50 px-4 py-2 text-sm text-neutral-500">
                <span>
                  Other projects ({drill.data.out_of_scope_project_count} projects)
                </span>
                <span className="font-mono">
                  {formatHours(drill.data.out_of_scope_hours)}
                </span>
              </li>
            ) : null}
          </ul>
        </Card>
      )}
    </div>
  );
}
