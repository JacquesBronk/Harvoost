'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Card,
  EmptyState,
  LoadingSpinner,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TimesheetStatusBadge,
  TR,
} from '@harvoost/ui';
import { DateTime } from 'luxon';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch } from '@/lib/api-client.js';
import { formatHours } from '@/lib/tz.js';
import type { Paginated } from '@/lib/api-types.js';

interface ApprovalQueueItem {
  id: string;
  user_id: string;
  user_name: string;
  iso_week: string;
  total_hours: number;
  status: string;
  submitted_at: string;
}

// TODO(build-phase-followup): batch Approve / Reject actions per row.
// POST /v1/approvals/timesheets/manager with { entry_ids[], action, reason? }.

export default function ApprovalsPage() {
  const queue = useQuery({
    queryKey: ['approvals', 'queue', 'manager'],
    queryFn: () =>
      apiFetch<Paginated<ApprovalQueueItem>>('/v1/approvals/queue', {
        query: { stage: 'manager', limit: 50 },
      }),
  });

  const items = queue.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Stage-1: review timesheets your team has submitted."
      />

      <Card title="Submitted timesheets" padded={false}>
        {queue.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading approval queue" />
          </div>
        ) : queue.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={queue.error} onRetry={() => queue.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="Inbox zero"
              description="No timesheets are waiting for your approval right now."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Employee</TH>
                <TH>Week</TH>
                <TH className="text-right">Hours</TH>
                <TH>Status</TH>
                <TH>Submitted</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={r.user_name} size="sm" />
                      <span className="font-medium text-neutral-900">{r.user_name}</span>
                    </div>
                  </TD>
                  <TD>{r.iso_week}</TD>
                  <TD className="text-right font-mono">{formatHours(r.total_hours)}</TD>
                  <TD>
                    <TimesheetStatusBadge status={r.status} />
                  </TD>
                  <TD className="text-neutral-500">
                    {DateTime.fromISO(r.submitted_at).toRelative()}
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
