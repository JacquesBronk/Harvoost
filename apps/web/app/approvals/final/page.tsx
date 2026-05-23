'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingSpinner,
  Modal,
  ModalContent,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  TimesheetStatusBadge,
  useToast,
} from '@harvoost/ui';
import { ChevronDown, ChevronRight, Check, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ApiError, apiFetch, describeError } from '@/lib/api-client.js';
import { formatHours } from '@/lib/tz.js';
import { useScope } from '@/lib/rbac.js';
import type {
  ApprovalBatchResponse,
  Paginated,
  TimeEntry,
} from '@/lib/api-types.js';

interface RejectModalState {
  weekKey: string;
  entryIds: string[];
  employeeName: string;
  reason: string;
  submitting: boolean;
  error?: string;
}

interface WeekGroup {
  weekKey: string;
  userId: string;
  userName: string;
  isoWeek: string;
  entries: TimeEntry[];
  totalHours: number;
}

export default function FinalApprovalsPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState<string | null>(null);

  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.canApproveStage2) {
      toast.info('Restricted', 'Final approvals are for FinMgr and Admin only.');
      router.replace('/approvals');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.canApproveStage2]);

  // The approval queue endpoint returns TimeEntry rows. For FinMgr callers the
  // server selects `manager_approved` entries; we group by (user, ISO week).
  const queueQuery = useQuery({
    enabled: !!scope.user && scope.canApproveStage2,
    queryKey: ['approvals', 'queue', 'final'],
    queryFn: () =>
      apiFetch<Paginated<TimeEntry> & { data?: TimeEntry[] }>(
        '/v1/approvals/queue',
        { query: { stage: 'final', limit: 200 } },
      ),
  });

  // Backend may return data under either `items` or `data` — accept both.
  const queueData = queueQuery.data;
  const entries: TimeEntry[] = useMemo(() => {
    if (!queueData) return [];
    if (Array.isArray(queueData.items)) return queueData.items;
    if (Array.isArray(queueData.data)) return queueData.data;
    return [];
  }, [queueData]);

  const groups: WeekGroup[] = useMemo(() => {
    const buckets = new Map<string, WeekGroup>();
    for (const entry of entries) {
      const dt = DateTime.fromISO(entry.start_at);
      if (!dt.isValid) continue;
      const isoWeek = `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`;
      const key = `${entry.user_id}__${isoWeek}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          weekKey: key,
          userId: entry.user_id,
          userName:
            (entry as TimeEntry & { user_name?: string }).user_name ??
            `User #${entry.user_id}`,
          isoWeek,
          entries: [],
          totalHours: 0,
        };
        buckets.set(key, bucket);
      }
      if (!bucket) continue;
      bucket.entries.push(entry);
      bucket.totalHours += entry.hours ?? 0;
    }
    return Array.from(buckets.values()).sort((a, b) =>
      a.userName.localeCompare(b.userName),
    );
  }, [entries]);

  const approveMutation = useMutation({
    mutationFn: (body: { action: 'approve' | 'reject'; entry_ids: string[]; reason?: string }) =>
      apiFetch<ApprovalBatchResponse>('/v1/approvals/timesheets/final', {
        method: 'POST',
        body,
      }),
  });

  async function approveWeek(group: WeekGroup) {
    setBatchSubmitting(group.weekKey);
    try {
      const result = await approveMutation.mutateAsync({
        action: 'approve',
        entry_ids: group.entries.map((e) => e.id),
      });
      if (result.skipped && result.skipped.length > 0) {
        toast.warning(
          'Partial approval',
          `${result.approved_ids.length} approved, ${result.skipped.length} skipped (likely stage-1 == stage-2 actor).`,
        );
      } else {
        toast.success(
          'Final approval recorded',
          `${result.approved_ids.length} entries for ${group.userName}.`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['approvals', 'queue'] });
    } catch (err) {
      let friendly = describeError(err);
      if (err instanceof ApiError) {
        if (err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'RBAC_FORBIDDEN') {
          friendly =
            'Stage-1 approver cannot also be the stage-2 approver. Ask another FinMgr or Admin to approve.';
        }
      }
      toast.error('Could not approve', friendly);
    } finally {
      setBatchSubmitting(null);
    }
  }

  async function submitReject() {
    if (!rejectModal) return;
    if (rejectModal.reason.trim().length < 10) {
      setRejectModal({ ...rejectModal, error: 'Reason must be at least 10 characters.' });
      return;
    }
    setRejectModal({ ...rejectModal, submitting: true, error: undefined });
    try {
      const result = await approveMutation.mutateAsync({
        action: 'reject',
        entry_ids: rejectModal.entryIds,
        reason: rejectModal.reason.trim(),
      });
      toast.success(
        'Rejection recorded',
        `${result.rejected_ids.length} entries for ${rejectModal.employeeName}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['approvals', 'queue'] });
      setRejectModal(null);
    } catch (err) {
      setRejectModal((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (scope.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="md" label="Loading" />
      </div>
    );
  }
  if (!scope.canApproveStage2) return null;

  return (
    <div>
      <PageHeader
        title="Final approvals"
        description="Stage-2: lock manager-approved timesheets for billing and payroll."
      />

      {queueQuery.isLoading ? (
        <Card title="Final approval queue">
          <LoadingSpinner size="md" label="Loading queue" />
        </Card>
      ) : queueQuery.isError ? (
        <Card title="Final approval queue">
          <ErrorBlock error={queueQuery.error} onRetry={() => queueQuery.refetch()} />
        </Card>
      ) : groups.length === 0 ? (
        <Card title="Final approval queue">
          <EmptyState
            title="No timesheets awaiting final approval"
            description="Manager-approved weeks will appear here."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => {
            const isExpanded = expanded.has(group.weekKey);
            const submitting = batchSubmitting === group.weekKey;
            return (
              <Card key={group.weekKey} padded={false}>
                <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleExpand(group.weekKey)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                      className="rounded p-1 text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                    <Avatar name={group.userName} size="md" />
                    <div>
                      <div className="font-semibold text-neutral-900">
                        {group.userName}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {group.isoWeek} · {group.entries.length} entries ·{' '}
                        <span className="font-mono">{formatHours(group.totalHours)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      iconLeft={<Check className="h-3.5 w-3.5" aria-hidden="true" />}
                      loading={submitting}
                      onClick={() => void approveWeek(group)}
                      disabled={submitting}
                    >
                      Final approve
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<X className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={() =>
                        setRejectModal({
                          weekKey: group.weekKey,
                          entryIds: group.entries.map((e) => e.id),
                          employeeName: group.userName,
                          reason: '',
                          submitting: false,
                        })
                      }
                      disabled={submitting}
                    >
                      Final reject
                    </Button>
                  </div>
                </div>
                {isExpanded ? (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH>Project</TH>
                        <TH>Task</TH>
                        <TH className="text-right">Hours</TH>
                        <TH>Status</TH>
                        <TH>Notes</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {group.entries.map((entry) => (
                        <TR key={entry.id}>
                          <TD className="text-neutral-700">
                            {DateTime.fromISO(entry.start_at).toFormat('dd LLL yyyy')}
                          </TD>
                          <TD className="font-medium text-neutral-900">
                            {entry.project_name ?? `#${entry.project_id}`}
                          </TD>
                          <TD className="text-neutral-700">{entry.task_name ?? '—'}</TD>
                          <TD className="text-right font-mono">
                            {formatHours(entry.hours)}
                          </TD>
                          <TD>
                            <TimesheetStatusBadge status={entry.status} />
                            {entry.billable === false ? (
                              <Badge tone="neutral" className="ml-1">
                                Non-billable
                              </Badge>
                            ) : null}
                          </TD>
                          <TD className="text-neutral-600">{entry.notes ?? '—'}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={!!rejectModal} onOpenChange={(open) => !open && setRejectModal(null)}>
        {rejectModal ? (
          <ModalContent
            title={`Reject week — ${rejectModal.employeeName}`}
            description="Reason is required (minimum 10 characters). The entries return to the manager for revisions."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setRejectModal(null)}
                  disabled={rejectModal.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={rejectModal.submitting}
                  onClick={() => void submitReject()}
                >
                  Reject {rejectModal.entryIds.length}{' '}
                  {rejectModal.entryIds.length === 1 ? 'entry' : 'entries'}
                </Button>
              </>
            }
          >
            <label
              htmlFor="final-reject-reason"
              className="block text-xs font-medium text-neutral-700"
            >
              Reason
            </label>
            <textarea
              id="final-reject-reason"
              rows={4}
              required
              minLength={10}
              value={rejectModal.reason}
              onChange={(e) =>
                setRejectModal((prev) =>
                  prev ? { ...prev, reason: e.target.value } : prev,
                )
              }
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              placeholder="e.g. Hours on the Atlas project exceed the budget — please re-categorise."
            />
            <p className="mt-1 text-xs text-neutral-500">
              {rejectModal.reason.trim().length} / 10 minimum characters
            </p>
            {rejectModal.error ? (
              <p role="alert" className="mt-2 text-xs text-danger-600">
                {rejectModal.error}
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>
    </div>
  );
}
