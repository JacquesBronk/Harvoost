'use client';

import { useQuery } from '@tanstack/react-query';
import {
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
import { apiFetch } from '@/lib/api-client.js';
import type { LeaveRequest, Paginated } from '@/lib/api-types.js';

// TODO(build-phase-followup): Add "Book leave" modal with leave_type / start / end / half_day fields.
// Hook to POST /v1/leave/requests; on success, invalidate ['leave', 'own'] query.

export default function LeavePage() {
  const leaveQuery = useQuery({
    queryKey: ['leave', 'own'],
    queryFn: () =>
      apiFetch<Paginated<LeaveRequest>>('/v1/leave/requests', {
        query: { mine: true, limit: 50 },
      }),
  });

  const items = leaveQuery.data?.items ?? [];

  const toneFor = (status: LeaveRequest['status']) => {
    if (status === 'approved') return 'success';
    if (status === 'rejected') return 'danger';
    if (status === 'cancelled') return 'neutral';
    return 'warning';
  };

  return (
    <div>
      <PageHeader title="Leave" description="Your leave requests and balances." />

      <Card title="My requests" padded={false}>
        {leaveQuery.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading leave requests" />
          </div>
        ) : leaveQuery.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={leaveQuery.error} onRetry={() => leaveQuery.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No leave requests yet"
              description="When you book leave, it will appear here while it awaits approval."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Type</TH>
                <TH>From</TH>
                <TH>To</TH>
                <TH>Status</TH>
                <TH>Note</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD className="capitalize">{r.leave_type}</TD>
                  <TD>{DateTime.fromISO(r.start_date).toFormat('dd LLL yyyy')}</TD>
                  <TD>{DateTime.fromISO(r.end_date).toFormat('dd LLL yyyy')}</TD>
                  <TD>
                    <Badge tone={toneFor(r.status)} dot>
                      {r.status}
                    </Badge>
                  </TD>
                  <TD className="text-neutral-600">{r.note ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
