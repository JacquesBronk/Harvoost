'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  LoadingSpinner,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@harvoost/ui';
import { DateTime } from 'luxon';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ScopeMetaIndicator } from '@/components/ScopeMetaIndicator.js';
import { apiFetch } from '@/lib/api-client.js';
import type { ExceptionRow, ScopedList } from '@/lib/api-types.js';

const TONE_BY_TYPE: Record<ExceptionRow['exception_type'], 'warning' | 'danger' | 'info'> = {
  MISSED_PUNCH: 'warning',
  OVERTIME_DAY: 'danger',
  OVERTIME_WEEK: 'danger',
  ANOMALY_LOW: 'info',
  ANOMALY_HIGH: 'info',
};

export default function ExceptionsPage() {
  const list = useQuery({
    queryKey: ['exceptions', 'open'],
    queryFn: () =>
      apiFetch<ScopedList<ExceptionRow>>('/v1/exceptions', {
        query: { status: 'open', limit: 100 },
      }),
  });

  const items = list.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Exceptions"
        description="Missed punches, overtime, and anomalies for your scoped view."
      />

      <div className="mb-3">
        <ScopeMetaIndicator scopeMeta={list.data?.scope_meta} />
      </div>

      <Card title="Open exceptions" padded={false}>
        {list.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading exceptions" />
          </div>
        ) : list.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No open exceptions"
              description="Missed punches, overtime, and anomalies for your team will show here as they appear."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Employee</TH>
                <TH>Type</TH>
                <TH>Date</TH>
                <TH>Details</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={row.user_name ?? 'Unknown'} size="sm" />
                      <span className="font-medium text-neutral-900">
                        {row.user_name ?? `User #${row.user_id}`}
                      </span>
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={TONE_BY_TYPE[row.exception_type]}>
                      {row.exception_type.replace('_', ' ').toLowerCase()}
                    </Badge>
                  </TD>
                  <TD>{DateTime.fromISO(row.local_date).toFormat('dd LLL yyyy')}</TD>
                  <TD className="font-mono text-xs text-neutral-600">
                    {JSON.stringify(row.details)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
