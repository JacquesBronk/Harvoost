'use client';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingSpinner,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  TimesheetStatusBadge,
  useToast,
} from '@harvoost/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock, Plus, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { StartTimerControl } from '@/components/StartTimerControl.js';
import { NewEntryForm } from '@/components/NewEntryForm.js';
import { apiFetch, describeError } from '@/lib/api-client.js';
import type { Paginated, SubmitWeekResponse, TimeEntry } from '@/lib/api-types.js';
import { formatHours, isoWeekRange, viewerTimeZone } from '@/lib/tz.js';
import {
  canSubmitWeek,
  fetchPeriod,
  isoWeekToken,
  periodLockBanner,
  submitWeek,
  summarizeSubmitResult,
} from '@/lib/timesheet-periods.js';
import { useCurrentUser } from '@/lib/auth.js';

export default function TimesheetsPage() {
  const { data: user } = useCurrentUser();
  const toast = useToast();
  const queryClient = useQueryClient();

  const zone = user?.timezone ?? viewerTimeZone();

  const [anchorIso, setAnchorIso] = useState(() => DateTime.now().setZone(zone).toISO());
  const [newEntryOpen, setNewEntryOpen] = useState(false);
  const week = useMemo(() => isoWeekRange(anchorIso ?? '', zone), [anchorIso, zone]);

  const entriesQuery = useQuery({
    queryKey: ['time-entries', 'own', week.startIso, week.endIso],
    queryFn: () =>
      apiFetch<Paginated<TimeEntry>>('/v1/time-entries', {
        query: {
          user_id: user?.id,
          start_at_from: week.startIso,
          start_at_to: week.endIso,
          limit: 200,
        },
      }),
    enabled: !!user,
  });

  const entries = entriesQuery.data?.items ?? [];

  // FEAT-002: read the period status for the current ISO week so we can show
  // whether it's open / submitted / approved and drive the Submit-week button +
  // locked banner. Resilient: if this call fails we fall back to the
  // entries-only behavior (no banner, gating from drafts alone) — never break
  // the page. Synthesized open shell when no row exists yet.
  const weekToken = useMemo(() => isoWeekToken(anchorIso, zone), [anchorIso, zone]);
  const periodQuery = useQuery({
    queryKey: ['timesheet-period', weekToken],
    queryFn: () => fetchPeriod(weekToken),
    enabled: !!user && !!weekToken,
    retry: false,
  });
  const period = periodQuery.isError ? undefined : periodQuery.data;
  const lockBanner = periodLockBanner(period);

  // Per API_NOTES.md (decision #4 + #10): per-week submission is expressed as
  // POST /v1/time-entries/{entry_id}/submit with scope=week. We send the
  // request against any draft entry in the week; the server interprets
  // scope=week and submits all draft entries in that ISO week, returning
  // { submitted_ids, skipped }.
  const submitMutation = useMutation({
    mutationFn: (): Promise<SubmitWeekResponse> => {
      const anyDraft = entries.find((e) => e.status === 'draft');
      if (!anyDraft) {
        throw new Error('Nothing to submit.');
      }
      return submitWeek(anyDraft.id);
    },
    onSuccess: (result) => {
      const { title, detail } = summarizeSubmitResult(result);
      if (result.submitted_ids.length === 0) {
        toast.warning(title, detail);
      } else if (result.skipped.length > 0) {
        // Partial success — some entries went through, some were skipped.
        toast.warning(title, detail);
      } else {
        toast.success(title, detail);
      }
      // The week is now locked; refresh both the entries and the period status
      // so the badge/banner and disabled Submit button reflect it immediately.
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet-period'] });
    },
    onError: (err) => toast.error('Submission failed', describeError(err)),
  });

  const totalsByDay = useMemo(() => groupTotals(entries, zone), [entries, zone]);
  const weekTotal = useMemo(
    () => entries.reduce((sum, e) => sum + (e.hours ?? 0), 0),
    [entries],
  );

  const hasDraft = entries.some((e) => e.status === 'draft');
  const canSubmit = canSubmitWeek(period, hasDraft);

  function shiftWeek(deltaDays: number) {
    const next = DateTime.fromISO(anchorIso ?? '', { zone })
      .plus({ days: deltaDays })
      .toISO();
    if (next) setAnchorIso(next);
  }

  return (
    <div>
      <PageHeader
        title="Timesheets"
        description="Review and submit your time for the week."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => shiftWeek(-7)}
              aria-label="Previous week"
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconRight={<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => shiftWeek(7)}
              aria-label="Next week"
            >
              Next
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={!!lockBanner}
              title={
                lockBanner ? `${lockBanner.label} — adding entries is disabled` : undefined
              }
              onClick={() => setNewEntryOpen(true)}
            >
              New entry
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Send className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={!canSubmit}
              loading={submitMutation.isPending}
              onClick={() => submitMutation.mutate()}
            >
              Submit week
            </Button>
          </>
        }
      />

      <Card title="Start a timer" className="mb-4">
        <StartTimerControl mode="start" layout="inline" />
      </Card>

      <NewEntryForm open={newEntryOpen} onOpenChange={setNewEntryOpen} zone={zone} />

      <Card
        title={week.weekLabel}
        subtitle={`All times shown in ${zone}`}
        actions={
          <div className="flex items-center gap-3">
            {lockBanner ? (
              <Badge tone={lockBanner.tone} dot>
                <Lock className="h-3 w-3" aria-hidden="true" />
                {lockBanner.label}
              </Badge>
            ) : null}
            <span className="text-sm font-semibold text-neutral-900">
              {formatHours(weekTotal)} total
            </span>
          </div>
        }
        padded={false}
      >
        {lockBanner ? (
          <div
            role="status"
            className="flex items-start gap-2 border-b border-neutral-100 bg-neutral-50/60 px-4 py-3 text-sm text-neutral-600"
          >
            <Lock
              className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400"
              aria-hidden="true"
            />
            <p>
              {lockBanner.label}. You can&rsquo;t add, edit, move, or delete entries
              in this week. An administrator can unlock it if a change is needed.
            </p>
          </div>
        ) : null}
        {entriesQuery.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading entries" />
          </div>
        ) : entriesQuery.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={entriesQuery.error} onRetry={() => entriesQuery.refetch()} />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No time logged this week"
              description="Start a timer from the bar above, or add a manual entry below."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Project</TH>
                <TH>Task</TH>
                <TH>Notes</TH>
                <TH className="text-right">Hours</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((entry) => (
                <TR key={entry.id}>
                  <TD className="whitespace-nowrap">
                    {DateTime.fromISO(entry.start_at, { setZone: true })
                      .setZone(zone)
                      .toFormat('ccc dd LLL')}
                  </TD>
                  <TD className="font-medium text-neutral-900">
                    {entry.project_name ?? `Project #${entry.project_id}`}
                  </TD>
                  <TD>{entry.task_name ?? '—'}</TD>
                  <TD className="max-w-xs truncate text-neutral-600">
                    {entry.notes ?? ''}
                  </TD>
                  <TD className="text-right font-mono text-sm">
                    {formatHours(entry.hours)}
                  </TD>
                  <TD>
                    <TimesheetStatusBadge status={entry.status} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {entries.length > 0 ? (
        <Card className="mt-4" title="Daily totals">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-7">
            {totalsByDay.map((d) => (
              <li
                key={d.date}
                className="rounded-md border border-neutral-200 bg-white px-3 py-2"
              >
                <div className="text-xs text-neutral-500">{d.label}</div>
                <div className="text-sm font-semibold text-neutral-900">
                  {formatHours(d.hours)}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function groupTotals(entries: TimeEntry[], zone: string) {
  const buckets = new Map<string, number>();
  for (const e of entries) {
    const d = DateTime.fromISO(e.start_at, { setZone: true }).setZone(zone).toISODate();
    if (!d) continue;
    buckets.set(d, (buckets.get(d) ?? 0) + (e.hours ?? 0));
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, hours]) => ({
      date,
      hours,
      label: DateTime.fromISO(date, { zone }).toFormat('ccc dd'),
    }));
}
