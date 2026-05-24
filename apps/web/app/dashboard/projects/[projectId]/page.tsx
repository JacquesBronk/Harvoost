'use client';

import { EmptyState, LoadingSpinner } from '@harvoost/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch } from '@/lib/api-client.js';
import { useCurrentUser } from '@/lib/auth.js';
import { currentIsoWeekRange, dateRangeParam, viewerTimeZone } from '@/lib/tz.js';
import type { ProjectRollupRow } from '@/lib/api-types.js';
import {
  ProjectBudgetCard,
  ProjectMembersCard,
  projectRollupTitle,
} from './rollup-views.js';

export default function ProjectRollupPage() {
  const params = useParams<{ projectId: string }>();
  const { data: user } = useCurrentUser();
  const zone = user?.timezone ?? viewerTimeZone();

  // INC-007: the rollup endpoint requires `date_range=YYYY-MM-DD/YYYY-MM-DD`
  // (parseDateRange throws otherwise → 400). Default to the current ISO week in
  // the viewer's zone, mirroring the team dashboard (apps/web/app/dashboard/page.tsx).
  const dateRange = useMemo(() => {
    const range = currentIsoWeekRange(zone);
    return dateRangeParam(range.from, range.to);
  }, [zone]);

  const rollup = useQuery({
    queryKey: ['dashboard', 'project-rollup', params.projectId, dateRange],
    queryFn: () =>
      apiFetch<ProjectRollupRow>(`/v1/reports/projects/${params.projectId}/rollup`, {
        query: { date_range: dateRange },
      }),
    enabled: !!params.projectId && !!dateRange,
  });

  return (
    <div>
      <PageHeader
        title={projectRollupTitle(rollup.data)}
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
          <ProjectBudgetCard data={rollup.data} />
          <ProjectMembersCard data={rollup.data} />
        </>
      )}
    </div>
  );
}
