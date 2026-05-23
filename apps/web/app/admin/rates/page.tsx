'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@harvoost/ui';
import { DateTime } from 'luxon';
import { History, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch, describeError } from '@/lib/api-client.js';
import { useScope } from '@/lib/rbac.js';
import type {
  AdminProject,
  BillableRate,
  CostRate,
  OffsetPaginated,
  User,
} from '@/lib/api-types.js';

// TODO(post-merge): swap to generated types once the cost-rates and
// billable-rates backend modules land. The endpoint paths used below
// (`/v1/cost-rates` and `/v1/billable-rates`) follow the architecture
// document's effective-dated rate pattern; verify against openapi.yaml
// when those modules are added.

const COMMON_CURRENCIES = ['ZAR', 'USD', 'EUR', 'GBP'];

interface CostRateEditorState {
  user: User;
  rate: string;
  currency: string;
  effectiveFrom: string;
  submitting: boolean;
  error?: string;
}

interface BillableRateEditorState {
  mode: 'create' | 'edit';
  project: AdminProject;
  taskId: string;
  rate: string;
  currency: string;
  effectiveFrom: string;
  submitting: boolean;
  error?: string;
}

interface HistoryDrawerState {
  kind: 'cost' | 'billable';
  user?: User;
  project?: AdminProject;
}

export default function AdminRatesPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.canSeeFinancialData) {
      toast.info('Restricted', 'Rate management is available to Admin and FinMgr only.');
      router.replace('/timesheets');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.canSeeFinancialData]);

  if (scope.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="md" label="Loading" />
      </div>
    );
  }
  if (!scope.canSeeFinancialData) return null;

  return (
    <div>
      <PageHeader
        title="Rates"
        description="Cost rates per employee and billable rates per project / task. Past rates remain immutable; edits create new effective-dated rows."
      />

      <Tabs defaultValue="cost">
        <TabsList>
          <TabsTrigger value="cost">Cost rates</TabsTrigger>
          <TabsTrigger value="billable">Billable rates</TabsTrigger>
        </TabsList>
        <TabsContent value="cost">
          <CostRatesTab />
        </TabsContent>
        <TabsContent value="billable">
          <BillableRatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CostRatesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<CostRateEditorState | null>(null);
  const [historyDrawer, setHistoryDrawer] = useState<HistoryDrawerState | null>(null);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users-for-rates'],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });

  // Effective-dated current cost rates per user. The backend returns one row
  // per user (the one whose effective_from <= today and effective_to is null
  // or > today).
  const ratesQuery = useQuery({
    queryKey: ['admin', 'cost-rates', 'current'],
    queryFn: () =>
      apiFetch<OffsetPaginated<CostRate>>('/v1/cost-rates', {
        query: { current: true, page: 1, page_size: 200 },
      }),
  });

  const setRateMutation = useMutation({
    mutationFn: (body: {
      user_id: string;
      rate: number;
      currency: string;
      effective_from: string;
    }) => apiFetch<CostRate>('/v1/cost-rates', { method: 'POST', body }),
  });

  async function submitEditor() {
    if (!editor) return;
    const rateNum = Number(editor.rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      setEditor({ ...editor, error: 'Rate must be a non-negative number.' });
      return;
    }
    if (!editor.effectiveFrom) {
      setEditor({ ...editor, error: 'Effective-from date is required.' });
      return;
    }
    setEditor({ ...editor, submitting: true, error: undefined });
    try {
      await setRateMutation.mutateAsync({
        user_id: editor.user.id,
        rate: rateNum,
        currency: editor.currency,
        effective_from: editor.effectiveFrom,
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'cost-rates'] });
      toast.success('Cost rate updated', editor.user.display_name);
      setEditor(null);
    } catch (err) {
      setEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  const users = usersQuery.data?.data ?? [];
  const ratesByUser = new Map<string, CostRate>();
  for (const rate of ratesQuery.data?.data ?? []) {
    ratesByUser.set(rate.user_id, rate);
  }

  return (
    <Card title="Cost rates per employee" padded={false}>
      {usersQuery.isLoading || ratesQuery.isLoading ? (
        <div className="px-4 py-8 text-center">
          <LoadingSpinner size="md" label="Loading rates" />
        </div>
      ) : usersQuery.isError ? (
        <div className="px-4 py-4">
          <ErrorBlock error={usersQuery.error} onRetry={() => usersQuery.refetch()} />
        </div>
      ) : users.length === 0 ? (
        <div className="px-4 py-8">
          <EmptyState title="No users yet" description="Users appear after their first sign-in." />
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Employee</TH>
              <TH className="text-right">Current rate</TH>
              <TH>Currency</TH>
              <TH>Effective from</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {users.map((user) => {
              const current = ratesByUser.get(user.id);
              return (
                <TR key={user.id}>
                  <TD>
                    <div className="font-medium text-neutral-900">{user.display_name}</div>
                    <div className="text-xs text-neutral-500">{user.email}</div>
                  </TD>
                  <TD className="text-right font-mono">
                    {current ? current.rate.toFixed(2) : <span className="text-neutral-400">—</span>}
                  </TD>
                  <TD className="font-mono text-xs">
                    {current?.currency ?? <span className="text-neutral-400">—</span>}
                  </TD>
                  <TD className="text-neutral-700">
                    {current
                      ? DateTime.fromISO(current.effective_from).toFormat('dd LLL yyyy')
                      : '—'}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setEditor({
                            user,
                            rate: current ? String(current.rate) : '',
                            currency: current?.currency ?? 'ZAR',
                            effectiveFrom: DateTime.now().toISODate() ?? '',
                            submitting: false,
                          })
                        }
                      >
                        Set rate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<History className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => setHistoryDrawer({ kind: 'cost', user })}
                      >
                        History
                      </Button>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {/* Set-rate modal */}
      <Modal open={!!editor} onOpenChange={(open) => !open && setEditor(null)}>
        {editor ? (
          <ModalContent
            title={`Set cost rate — ${editor.user.display_name}`}
            description="Setting a new rate ends the previous rate's effective period."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setEditor(null)}
                  disabled={editor.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={editor.submitting}
                  onClick={() => void submitEditor()}
                >
                  Save rate
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Input
                label="Hourly cost rate"
                type="number"
                min={0}
                step="0.01"
                required
                value={editor.rate}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, rate: e.target.value } : p))
                }
              />
              <Select
                label="Currency"
                value={editor.currency}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, currency: e.target.value } : p))
                }
                options={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
              <Input
                label="Effective from"
                type="date"
                required
                value={editor.effectiveFrom}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, effectiveFrom: e.target.value } : p))
                }
              />
              {editor.error ? (
                <p role="alert" className="text-xs text-danger-600">
                  {editor.error}
                </p>
              ) : null}
            </div>
          </ModalContent>
        ) : null}
      </Modal>

      {/* History drawer */}
      <Modal
        open={!!historyDrawer}
        onOpenChange={(open) => !open && setHistoryDrawer(null)}
      >
        {historyDrawer ? (
          <ModalContent
            size="lg"
            title={
              historyDrawer.kind === 'cost'
                ? `Cost rate history — ${historyDrawer.user?.display_name}`
                : `Billable rate history — ${historyDrawer.project?.name}`
            }
            description="All historical rates; immutable for audit."
            footer={
              <Button variant="primary" onClick={() => setHistoryDrawer(null)}>
                Done
              </Button>
            }
          >
            {historyDrawer.kind === 'cost' && historyDrawer.user ? (
              <CostRateHistory userId={historyDrawer.user.id} />
            ) : historyDrawer.project ? (
              <BillableRateHistory projectId={historyDrawer.project.id} />
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>
    </Card>
  );
}

function CostRateHistory({ userId }: { userId: string }) {
  const historyQuery = useQuery({
    queryKey: ['admin', 'cost-rates', 'history', userId],
    queryFn: () =>
      apiFetch<OffsetPaginated<CostRate>>(`/v1/cost-rates`, {
        query: { user_id: userId, page: 1, page_size: 100 },
      }),
  });

  if (historyQuery.isLoading) return <LoadingSpinner size="sm" label="Loading history" />;
  if (historyQuery.isError) {
    return <ErrorBlock error={historyQuery.error} onRetry={() => historyQuery.refetch()} />;
  }
  const rows = historyQuery.data?.data ?? [];
  if (rows.length === 0) {
    return <EmptyState title="No rate history" description="No prior rates on file." />;
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH className="text-right">Rate</TH>
          <TH>Currency</TH>
          <TH>From</TH>
          <TH>To</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD className="text-right font-mono">{r.rate.toFixed(2)}</TD>
            <TD className="font-mono text-xs">{r.currency}</TD>
            <TD>{DateTime.fromISO(r.effective_from).toFormat('dd LLL yyyy')}</TD>
            <TD>
              {r.effective_to ? (
                DateTime.fromISO(r.effective_to).toFormat('dd LLL yyyy')
              ) : (
                <Badge tone="success" dot>
                  Current
                </Badge>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function BillableRatesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<BillableRateEditorState | null>(null);
  const [historyDrawer, setHistoryDrawer] = useState<HistoryDrawerState | null>(null);

  const projectsQuery = useQuery({
    queryKey: ['admin', 'projects-for-rates'],
    queryFn: () =>
      apiFetch<OffsetPaginated<AdminProject>>('/v1/projects', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });

  const ratesQuery = useQuery({
    queryKey: ['admin', 'billable-rates', 'current'],
    queryFn: () =>
      apiFetch<OffsetPaginated<BillableRate>>('/v1/billable-rates', {
        query: { current: true, page: 1, page_size: 200 },
      }),
  });

  const setRateMutation = useMutation({
    mutationFn: (body: {
      project_id: string;
      task_id?: string;
      rate: number;
      currency: string;
      effective_from: string;
    }) =>
      apiFetch<BillableRate>('/v1/billable-rates', {
        method: 'POST',
        body,
      }),
  });

  async function submitEditor() {
    if (!editor) return;
    const rateNum = Number(editor.rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      setEditor({ ...editor, error: 'Rate must be a non-negative number.' });
      return;
    }
    setEditor({ ...editor, submitting: true, error: undefined });
    try {
      await setRateMutation.mutateAsync({
        project_id: editor.project.id,
        task_id: editor.taskId ? editor.taskId : undefined,
        rate: rateNum,
        currency: editor.currency,
        effective_from: editor.effectiveFrom,
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'billable-rates'] });
      toast.success('Billable rate updated', editor.project.name);
      setEditor(null);
    } catch (err) {
      setEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  const projects = projectsQuery.data?.data ?? [];
  // Each project may have multiple billable rates (default + per-task).
  // For the table we show the "default" (task_id is null) row per project.
  const defaultRateByProject = new Map<string, BillableRate>();
  for (const r of ratesQuery.data?.data ?? []) {
    if (r.task_id == null) {
      defaultRateByProject.set(r.project_id, r);
    }
  }

  return (
    <Card title="Billable rates per project" padded={false}>
      {projectsQuery.isLoading || ratesQuery.isLoading ? (
        <div className="px-4 py-8 text-center">
          <LoadingSpinner size="md" label="Loading rates" />
        </div>
      ) : projectsQuery.isError ? (
        <div className="px-4 py-4">
          <ErrorBlock
            error={projectsQuery.error}
            onRetry={() => projectsQuery.refetch()}
          />
        </div>
      ) : projects.length === 0 ? (
        <div className="px-4 py-8">
          <EmptyState title="No projects yet" description="Create projects first." />
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Project</TH>
              <TH>Task</TH>
              <TH className="text-right">Default rate</TH>
              <TH>Currency</TH>
              <TH>Effective from</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {projects.map((project) => {
              const rate = defaultRateByProject.get(project.id);
              return (
                <TR key={project.id}>
                  <TD>
                    <div className="font-medium text-neutral-900">{project.name}</div>
                    <div className="text-xs text-neutral-500">{project.client_name ?? '—'}</div>
                  </TD>
                  <TD className="text-neutral-500">default</TD>
                  <TD className="text-right font-mono">
                    {rate ? rate.rate.toFixed(2) : <span className="text-neutral-400">—</span>}
                  </TD>
                  <TD className="font-mono text-xs">
                    {rate?.currency ?? project.currency}
                  </TD>
                  <TD className="text-neutral-700">
                    {rate
                      ? DateTime.fromISO(rate.effective_from).toFormat('dd LLL yyyy')
                      : '—'}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setEditor({
                            mode: rate ? 'edit' : 'create',
                            project,
                            taskId: '',
                            rate: rate ? String(rate.rate) : '',
                            currency: rate?.currency ?? project.currency,
                            effectiveFrom: DateTime.now().toISODate() ?? '',
                            submitting: false,
                          })
                        }
                      >
                        Set rate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<History className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => setHistoryDrawer({ kind: 'billable', project })}
                      >
                        History
                      </Button>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {/* Set-rate modal */}
      <Modal open={!!editor} onOpenChange={(open) => !open && setEditor(null)}>
        {editor ? (
          <ModalContent
            title={`Set billable rate — ${editor.project.name}`}
            description="Setting a new rate ends the previous rate's effective period."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setEditor(null)}
                  disabled={editor.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={editor.submitting}
                  onClick={() => void submitEditor()}
                >
                  Save rate
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Input
                label="Task ID (optional, leave blank for project default)"
                type="number"
                min={1}
                value={editor.taskId}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, taskId: e.target.value } : p))
                }
              />
              <Input
                label="Hourly billable rate"
                type="number"
                min={0}
                step="0.01"
                required
                value={editor.rate}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, rate: e.target.value } : p))
                }
              />
              <Select
                label="Currency"
                value={editor.currency}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, currency: e.target.value } : p))
                }
                options={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
              <Input
                label="Effective from"
                type="date"
                required
                value={editor.effectiveFrom}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, effectiveFrom: e.target.value } : p))
                }
              />
              {editor.error ? (
                <p role="alert" className="text-xs text-danger-600">
                  {editor.error}
                </p>
              ) : null}
            </div>
          </ModalContent>
        ) : null}
      </Modal>

      {/* History */}
      <Modal
        open={!!historyDrawer}
        onOpenChange={(open) => !open && setHistoryDrawer(null)}
      >
        {historyDrawer && historyDrawer.project ? (
          <ModalContent
            size="lg"
            title={`Billable rate history — ${historyDrawer.project.name}`}
            footer={
              <Button variant="primary" onClick={() => setHistoryDrawer(null)}>
                Done
              </Button>
            }
          >
            <BillableRateHistory projectId={historyDrawer.project.id} />
          </ModalContent>
        ) : null}
      </Modal>
    </Card>
  );
}

function BillableRateHistory({ projectId }: { projectId: string }) {
  const historyQuery = useQuery({
    queryKey: ['admin', 'billable-rates', 'history', projectId],
    queryFn: () =>
      apiFetch<OffsetPaginated<BillableRate>>(`/v1/billable-rates`, {
        query: { project_id: projectId, page: 1, page_size: 100 },
      }),
  });

  if (historyQuery.isLoading) return <LoadingSpinner size="sm" label="Loading history" />;
  if (historyQuery.isError) {
    return <ErrorBlock error={historyQuery.error} onRetry={() => historyQuery.refetch()} />;
  }
  const rows = historyQuery.data?.data ?? [];
  if (rows.length === 0) {
    return <EmptyState title="No rate history" description="No prior rates on file." />;
  }
  return (
    <Table>
      <THead>
        <TR>
          <TH>Task</TH>
          <TH className="text-right">Rate</TH>
          <TH>Currency</TH>
          <TH>From</TH>
          <TH>To</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD>{r.task_name ?? <span className="text-neutral-500">default</span>}</TD>
            <TD className="text-right font-mono">{r.rate.toFixed(2)}</TD>
            <TD className="font-mono text-xs">{r.currency}</TD>
            <TD>{DateTime.fromISO(r.effective_from).toFormat('dd LLL yyyy')}</TD>
            <TD>
              {r.effective_to ? (
                DateTime.fromISO(r.effective_to).toFormat('dd LLL yyyy')
              ) : (
                <Badge tone="success" dot>
                  Current
                </Badge>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
