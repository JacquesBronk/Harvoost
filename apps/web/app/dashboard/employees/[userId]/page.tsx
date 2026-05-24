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
import {
  EmployeePerProjectCard,
  employeeRollupTitle,
  type EmployeeDrillIn,
} from './rollup-views.js';

export default function EmployeeDrillPage() {
  const params = useParams<{ userId: string }>();
  const { data: user } = useCurrentUser();
  const zone = user?.timezone ?? viewerTimeZone();

  // INC-007: the rollup endpoint requires `date_range=YYYY-MM-DD/YYYY-MM-DD`
  // (parseDateRange throws otherwise → 400). Default to the current ISO week in
  // the viewer's zone, mirroring the team dashboard (apps/web/app/dashboard/page.tsx).
  const dateRange = useMemo(() => {
    const range = currentIsoWeekRange(zone);
    return dateRangeParam(range.from, range.to);
  }, [zone]);

  const drill = useQuery({
    queryKey: ['dashboard', 'employee', params.userId, dateRange],
    queryFn: () =>
      apiFetch<EmployeeDrillIn>(`/v1/reports/employees/${params.userId}/rollup`, {
        query: { date_range: dateRange },
      }),
    enabled: !!params.userId && !!dateRange,
  });

  return (
    <div>
      <PageHeader
        title={employeeRollupTitle(drill.data)}
        description="Hours by project within your visible scope."
      />
      {drill.isLoading ? (
        <LoadingSpinner size="md" label="Loading employee data" />
      ) : drill.isError ? (
        <ErrorBlock error={drill.error} onRetry={() => drill.refetch()} />
      ) : !drill.data ? (
        <EmptyState title="No data" />
      ) : (
        <EmployeePerProjectCard data={drill.data} />
      )}
    </div>
  );
}
