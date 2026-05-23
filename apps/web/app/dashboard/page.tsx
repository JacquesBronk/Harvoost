'use client';

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
  useToast,
} from '@harvoost/ui';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Select } from '@harvoost/ui';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ScopeMetaIndicator } from '@/components/ScopeMetaIndicator.js';
import { apiFetch } from '@/lib/api-client.js';
import { useCurrentUser } from '@/lib/auth.js';
import { useScope } from '@/lib/rbac.js';
import { formatHours, isoWeekRange, viewerTimeZone } from '@/lib/tz.js';
import type { ScopedList, TeamDashboardRow } from '@/lib/api-types.js';

export default function DashboardPage() {
  const { data: user } = useCurrentUser();
  const scope = useScope();
  const toast = useToast();
  const zone = user?.timezone ?? viewerTimeZone();

  const [rangeKey, setRangeKey] = useState<'this_week' | 'last_week' | 'this_month'>(
    'this_week',
  );

  const range = useMemo(() => {
    const now = DateTime.now().setZone(zone);
    if (rangeKey === 'this_week') {
      const w = isoWeekRange(now.toISO() ?? '', zone);
      return { from: w.startIso, to: w.endIso, label: w.weekLabel };
    }
    if (rangeKey === 'last_week') {
      const w = isoWeekRange(now.minus({ weeks: 1 }).toISO() ?? '', zone);
      return { from: w.startIso, to: w.endIso, label: w.weekLabel };
    }
    const start = now.startOf('month');
    const end = start.plus({ months: 1 });
    return {
      from: start.toUTC().toISO() ?? '',
      to: end.toUTC().toISO() ?? '',
      label: start.toFormat('LLLL yyyy'),
    };
  }, [rangeKey, zone]);

  const dashboard = useQuery({
    queryKey: ['dashboard', 'team', range.from, range.to],
    queryFn: () =>
      apiFetch<ScopedList<TeamDashboardRow>>('/v1/reports/team-dashboard', {
        query: { start_at_from: range.from, start_at_to: range.to },
      }),
    enabled: !!user,
  });

  const restricted = !!user && !scope.canApproveStage1 && !scope.canApproveStage2;
  useEffect(() => {
    if (restricted) {
      toast.info(
        'Dashboard restricted',
        'You can only view your own data. Visit Timesheets for your own activity.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restricted]);

  if (restricted) {
    return (
      <div>
        <PageHeader title="Team dashboard" />
        <EmptyState
          title="No access"
          description="The team dashboard is available to managers, financial managers, and admins."
          action={
            <Link href="/timesheets" className="text-brand-700 hover:text-brand-800">
              Go to my timesheet
            </Link>
          }
        />
      </div>
    );
  }

  const rows = dashboard.data?.items ?? [];
  const total = rows.reduce((s, r) => s + r.total_hours, 0);

  return (
    <div>
      <PageHeader
        title="Team dashboard"
        description={`Week-to-date hours for your scoped team. ${range.label}.`}
        actions={
          <Select
            options={[
              { value: 'this_week', label: 'This week' },
              { value: 'last_week', label: 'Last week' },
              { value: 'this_month', label: 'This month' },
            ]}
            value={rangeKey}
            onChange={(e) =>
              setRangeKey(e.target.value as 'this_week' | 'last_week' | 'this_month')
            }
            aria-label="Date range"
          />
        }
      />

      <div className="mb-3">
        <ScopeMetaIndicator scopeMeta={dashboard.data?.scope_meta} />
      </div>

      <Card
        title="Team activity"
        subtitle={`${rows.length} team members · ${formatHours(total)} total`}
        padded={false}
      >
        {dashboard.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading team data" />
          </div>
        ) : dashboard.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={dashboard.error} onRetry={() => dashboard.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No team assigned yet"
              description="Contact your administrator to be anchored to one or more projects or employees."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Employee</TH>
                <TH>Top projects</TH>
                <TH className="text-right">Hours</TH>
                <TH className="text-right">Missed punches</TH>
                <TH className="text-right">Overtime</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.user_id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={row.display_name} size="sm" />
                      <span className="font-medium text-neutral-900">
                        {row.display_name}
                      </span>
                    </div>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {row.hours_by_project.slice(0, 3).map((p) => (
                        <Badge key={p.project_id} tone="neutral">
                          {p.project_name} · {formatHours(p.hours)}
                        </Badge>
                      ))}
                      {row.hours_by_project.length > 3 ? (
                        <Badge tone="neutral">
                          +{row.hours_by_project.length - 3} more
                        </Badge>
                      ) : null}
                    </div>
                  </TD>
                  <TD className="text-right font-mono">{formatHours(row.total_hours)}</TD>
                  <TD className="text-right">
                    {row.missed_punch_count > 0 ? (
                      <Badge tone="warning">{row.missed_punch_count}</Badge>
                    ) : (
                      <span className="text-neutral-400">0</span>
                    )}
                  </TD>
                  <TD className="text-right">
                    {row.overtime_count > 0 ? (
                      <Badge tone="danger">{row.overtime_count}</Badge>
                    ) : (
                      <span className="text-neutral-400">0</span>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Link
                      href={`/dashboard/employees/${row.user_id}`}
                      className="text-sm text-brand-700 hover:text-brand-800"
                    >
                      View
                    </Link>
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
