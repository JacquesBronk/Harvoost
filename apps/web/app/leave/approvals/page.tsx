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
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@harvoost/ui';
import { Check, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ApiError, apiFetch, describeError } from '@/lib/api-client.js';
import { useScope } from '@/lib/rbac.js';
import type { LeaveRequest, Paginated } from '@/lib/api-types.js';

interface ApproveConfirmState {
  request: LeaveRequest;
  submitting: boolean;
  error?: string;
}

interface RejectConfirmState {
  request: LeaveRequest;
  reason: string;
  submitting: boolean;
  error?: string;
}

export default function LeaveApprovalsPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected'>(
    'pending',
  );
  const [approveConfirm, setApproveConfirm] = useState<ApproveConfirmState | null>(null);
  const [rejectConfirm, setRejectConfirm] = useState<RejectConfirmState | null>(null);

  useEffect(() => {
    const canApproveLeave =
      !scope.isLoading &&
      scope.user &&
      (scope.isAdmin || scope.canApproveStage1 || scope.canSeeFinancialData);
    if (!scope.isLoading && scope.user && !canApproveLeave) {
      toast.info(
        'Restricted',
        'Leave approvals are available to Managers, Admins, and FinMgrs.',
      );
      router.replace('/leave');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.isAdmin, scope.canApproveStage1, scope.canSeeFinancialData]);

  const pending = useQuery({
    enabled: !!scope.user,
    queryKey: ['leave', 'approvals', { status: statusFilter }],
    queryFn: () =>
      apiFetch<Paginated<LeaveRequest>>('/v1/leave/requests', {
        query: { status: statusFilter, limit: 50 },
      }),
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      // HTTP verb is PATCH per openapi.yaml § /v1/leave/requests/{id}/approve
      // (was POST in an earlier draft; backend-dev is shipping the PATCH form
      // in this pass).
      apiFetch<LeaveRequest>(`/v1/leave/requests/${requestId}/approve`, {
        method: 'PATCH',
      }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) =>
      apiFetch<LeaveRequest>(`/v1/leave/requests/${requestId}/reject`, {
        method: 'PATCH',
        body: { reason },
      }),
  });

  async function submitApprove() {
    if (!approveConfirm) return;
    setApproveConfirm({ ...approveConfirm, submitting: true, error: undefined });
    try {
      await approveMutation.mutateAsync(approveConfirm.request.id);
      await queryClient.invalidateQueries({ queryKey: ['leave', 'approvals'] });
      toast.success(
        'Leave approved',
        approveConfirm.request.user_name ?? 'Request approved.',
      );
      setApproveConfirm(null);
    } catch (err) {
      const friendly =
        err instanceof ApiError && err.status === 403
          ? 'You do not have approval rights for this request.'
          : describeError(err);
      setApproveConfirm((prev) =>
        prev ? { ...prev, submitting: false, error: friendly } : prev,
      );
    }
  }

  async function submitReject() {
    if (!rejectConfirm) return;
    if (rejectConfirm.reason.trim().length < 10) {
      setRejectConfirm({
        ...rejectConfirm,
        error: 'Reason must be at least 10 characters.',
      });
      return;
    }
    setRejectConfirm({ ...rejectConfirm, submitting: true, error: undefined });
    try {
      await rejectMutation.mutateAsync({
        requestId: rejectConfirm.request.id,
        reason: rejectConfirm.reason.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ['leave', 'approvals'] });
      toast.success('Leave rejected', `Reason recorded for ${rejectConfirm.request.user_name ?? 'the requester'}.`);
      setRejectConfirm(null);
    } catch (err) {
      setRejectConfirm((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  const items = pending.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Leave approvals"
        description="Pending leave requests from your scoped team."
      />

      <Card title="Requests" padded={false}>
        <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <div className="w-48">
            <Select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'pending' | 'approved' | 'rejected')
              }
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
              ]}
            />
          </div>
        </div>

        {pending.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading requests" />
          </div>
        ) : pending.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={pending.error} onRetry={() => pending.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title={statusFilter === 'pending' ? 'No pending requests' : 'No requests'}
              description="When your team books leave it will show here for approval."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Employee</TH>
                <TH>Type</TH>
                <TH>Dates</TH>
                <TH>Note</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={r.user_name ?? 'Unknown'} size="sm" />
                      <span className="font-medium text-neutral-900">{r.user_name}</span>
                    </div>
                  </TD>
                  <TD>
                    <Badge tone="info">{r.leave_type}</Badge>
                    {r.half_day ? (
                      <Badge tone="neutral" className="ml-1">
                        Half day ({r.half_day})
                      </Badge>
                    ) : null}
                  </TD>
                  <TD>
                    {DateTime.fromISO(r.start_date).toFormat('dd LLL')} –{' '}
                    {DateTime.fromISO(r.end_date).toFormat('dd LLL yyyy')}
                  </TD>
                  <TD className="text-neutral-600">{r.note ?? '—'}</TD>
                  <TD className="text-right">
                    {r.status === 'pending' ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          iconLeft={<Check className="h-3.5 w-3.5" aria-hidden="true" />}
                          onClick={() =>
                            setApproveConfirm({ request: r, submitting: false })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconLeft={<X className="h-3.5 w-3.5" aria-hidden="true" />}
                          onClick={() =>
                            setRejectConfirm({
                              request: r,
                              reason: '',
                              submitting: false,
                            })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <Badge tone={r.status === 'approved' ? 'success' : 'danger'} dot>
                        {r.status}
                      </Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Approve confirmation */}
      <Modal
        open={!!approveConfirm}
        onOpenChange={(open) => !open && setApproveConfirm(null)}
      >
        {approveConfirm ? (
          <ModalContent
            title="Approve leave request?"
            description={`${approveConfirm.request.user_name ?? 'Employee'} requested ${
              approveConfirm.request.leave_type
            } leave from ${DateTime.fromISO(approveConfirm.request.start_date).toFormat(
              'dd LLL',
            )} to ${DateTime.fromISO(approveConfirm.request.end_date).toFormat(
              'dd LLL yyyy',
            )}.`}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setApproveConfirm(null)}
                  disabled={approveConfirm.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={approveConfirm.submitting}
                  onClick={() => void submitApprove()}
                >
                  Approve
                </Button>
              </>
            }
          >
            {approveConfirm.error ? (
              <p role="alert" className="text-xs text-danger-600">
                {approveConfirm.error}
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>

      {/* Reject confirmation */}
      <Modal
        open={!!rejectConfirm}
        onOpenChange={(open) => !open && setRejectConfirm(null)}
      >
        {rejectConfirm ? (
          <ModalContent
            title="Reject leave request"
            description="Reason is required (minimum 10 characters)."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setRejectConfirm(null)}
                  disabled={rejectConfirm.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={rejectConfirm.submitting}
                  onClick={() => void submitReject()}
                >
                  Reject leave
                </Button>
              </>
            }
          >
            <label
              htmlFor="reject-reason"
              className="block text-xs font-medium text-neutral-700"
            >
              Reason
            </label>
            <textarea
              id="reject-reason"
              rows={4}
              required
              minLength={10}
              value={rejectConfirm.reason}
              onChange={(e) =>
                setRejectConfirm((prev) =>
                  prev ? { ...prev, reason: e.target.value } : prev,
                )
              }
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              placeholder="e.g. Coverage conflict with the support rotation that week."
            />
            <p className="mt-1 text-xs text-neutral-500">
              {rejectConfirm.reason.trim().length} / 10 minimum characters
            </p>
            {rejectConfirm.error ? (
              <p role="alert" className="mt-2 text-xs text-danger-600">
                {rejectConfirm.error}
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>
    </div>
  );
}
