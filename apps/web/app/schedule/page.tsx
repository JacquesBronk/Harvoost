'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingSpinner,
  Modal,
  ModalContent,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@harvoost/ui';
import { CalendarPlus, Info } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch, describeError } from '@/lib/api-client.js';
import { useCurrentUser } from '@/lib/auth.js';
import { useScope } from '@/lib/rbac.js';
import { viewerTimeZone } from '@/lib/tz.js';
import type {
  AdminProject,
  CreateScheduleOverrideRequest,
  OffsetPaginated,
  ScheduleDashboardRow,
  ScheduleOverride,
  ScheduleOverrideScope,
  User,
} from '@/lib/api-types.js';

type TabKey = 'company' | 'team' | 'individual';

interface OverrideEditorState {
  scope: ScheduleOverrideScope;
  userId: string;
  projectId: string;
  effectiveFrom: string;
  effectiveTo: string;
  startTime: string;
  endTime: string;
  lunchStart: string;
  lunchEnd: string;
  reason: string;
  submitting: boolean;
  error?: string;
}

const DEFAULT_START = '08:00';
const DEFAULT_END = '17:00';
const DEFAULT_LUNCH_START = '12:00';
const DEFAULT_LUNCH_END = '13:00';

export default function SchedulePage() {
  const scope = useScope();
  const { data: user } = useCurrentUser();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [overrideEditor, setOverrideEditor] = useState<OverrideEditorState | null>(null);

  // Default the date range to the current ISO week (Mon–Sun).
  const today = DateTime.now();
  const [dateFrom, setDateFrom] = useState(
    today.startOf('week').toISODate() ?? today.toISODate() ?? '',
  );
  const [dateTo, setDateTo] = useState(
    today.endOf('week').toISODate() ?? today.toISODate() ?? '',
  );
  const [individualUserId, setIndividualUserId] = useState<string>('');

  // Pick a sensible default tab based on role.
  const defaultTab: TabKey = scope.canSeeFinancialData ? 'company' : 'team';

  useEffect(() => {
    if (!individualUserId && user) {
      setIndividualUserId(String(user.id));
    }
  }, [user, individualUserId]);

  const canCreateOverride =
    scope.isAdmin || scope.canSeeFinancialData || scope.canApproveStage1;

  const createOverrideMutation = useMutation({
    mutationFn: (body: CreateScheduleOverrideRequest) =>
      apiFetch<ScheduleOverride>('/v1/schedules/overrides', {
        method: 'POST',
        body,
      }),
  });

  async function submitOverride() {
    if (!overrideEditor) return;
    const errors: string[] = [];
    if (!overrideEditor.effectiveFrom) errors.push('Effective-from is required.');
    if (!overrideEditor.effectiveTo) errors.push('Effective-to is required.');
    if (
      overrideEditor.effectiveFrom &&
      overrideEditor.effectiveTo &&
      overrideEditor.effectiveTo < overrideEditor.effectiveFrom
    ) {
      errors.push('Effective-to must be on or after Effective-from.');
    }
    if (overrideEditor.scope === 'user' && !overrideEditor.userId) {
      errors.push('User scope requires a target user.');
    }
    if (overrideEditor.scope === 'project' && !overrideEditor.projectId) {
      errors.push('Project scope requires a target project.');
    }
    if (errors.length > 0) {
      setOverrideEditor({ ...overrideEditor, error: errors.join(' ') });
      return;
    }
    setOverrideEditor({ ...overrideEditor, submitting: true, error: undefined });
    try {
      const body: CreateScheduleOverrideRequest = {
        scope: overrideEditor.scope,
        effective_from: overrideEditor.effectiveFrom,
        effective_to: overrideEditor.effectiveTo,
      };
      if (overrideEditor.scope === 'user' && overrideEditor.userId) {
        body.user_id = overrideEditor.userId;
      }
      if (overrideEditor.scope === 'project' && overrideEditor.projectId) {
        body.project_id = overrideEditor.projectId;
      }
      if (overrideEditor.startTime) body.start_time = overrideEditor.startTime;
      if (overrideEditor.endTime) body.end_time = overrideEditor.endTime;
      if (overrideEditor.lunchStart) body.lunch_start_time = overrideEditor.lunchStart;
      if (overrideEditor.lunchEnd) body.lunch_end_time = overrideEditor.lunchEnd;
      if (overrideEditor.reason.trim()) body.reason = overrideEditor.reason.trim();

      await createOverrideMutation.mutateAsync(body);
      toast.success('Override created');
      await queryClient.invalidateQueries({ queryKey: ['schedule', 'dashboard'] });
      setOverrideEditor(null);
    } catch (err) {
      setOverrideEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  if (scope.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="md" label="Loading" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Schedule"
        description="See who is scheduled when. All times rendered in your timezone; employee TZ shown on hover."
        actions={
          canCreateOverride ? (
            <Button
              variant="primary"
              iconLeft={<CalendarPlus className="h-4 w-4" aria-hidden="true" />}
              onClick={() =>
                setOverrideEditor({
                  scope: scope.canSeeFinancialData ? 'org' : 'user',
                  userId: '',
                  projectId: '',
                  effectiveFrom: today.toISODate() ?? '',
                  effectiveTo: today.plus({ days: 6 }).toISODate() ?? '',
                  startTime: DEFAULT_START,
                  endTime: DEFAULT_END,
                  lunchStart: DEFAULT_LUNCH_START,
                  lunchEnd: DEFAULT_LUNCH_END,
                  reason: '',
                  submitting: false,
                })
              }
            >
              New override
            </Button>
          ) : null
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-neutral-100 px-4 py-3">
          <div>
            <Input
              label="From"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div>
            <Input
              label="To"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1 text-xs text-neutral-500">
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
            Viewer TZ: <span className="font-mono">{viewerTimeZone()}</span>
          </div>
        </div>

        <div className="px-4 py-4">
          <Tabs defaultValue={defaultTab}>
            <TabsList>
              {scope.canSeeFinancialData ? (
                <TabsTrigger value="company">Company</TabsTrigger>
              ) : null}
              <TabsTrigger value="team">Team</TabsTrigger>
              <TabsTrigger value="individual">Individual</TabsTrigger>
            </TabsList>

            {scope.canSeeFinancialData ? (
              <TabsContent value="company">
                <ScheduleGrid tab="company" dateFrom={dateFrom} dateTo={dateTo} />
              </TabsContent>
            ) : null}
            <TabsContent value="team">
              <ScheduleGrid tab="team" dateFrom={dateFrom} dateTo={dateTo} />
            </TabsContent>
            <TabsContent value="individual">
              <IndividualPicker
                value={individualUserId}
                onChange={setIndividualUserId}
                canPickOthers={scope.canSeeFinancialData || scope.canApproveStage1}
              />
              {individualUserId ? (
                <ScheduleGrid
                  tab="individual"
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  userId={individualUserId}
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </Card>

      {/* New override modal */}
      <Modal
        open={!!overrideEditor}
        onOpenChange={(open) => !open && setOverrideEditor(null)}
      >
        {overrideEditor ? (
          <OverrideModal
            state={overrideEditor}
            setState={setOverrideEditor}
            onSubmit={() => void submitOverride()}
            allowedScopes={
              scope.canSeeFinancialData
                ? ['user', 'project', 'org']
                : ['user'] // Managers can only override their scoped users
            }
          />
        ) : null}
      </Modal>
    </div>
  );
}

function ScheduleGrid({
  tab,
  dateFrom,
  dateTo,
  userId,
}: {
  tab: TabKey;
  dateFrom: string;
  dateTo: string;
  userId?: string;
}) {
  const query = useQuery({
    enabled: !!dateFrom && !!dateTo && (tab !== 'individual' || userId !== undefined),
    queryKey: ['schedule', 'dashboard', { tab, dateFrom, dateTo, userId }],
    queryFn: () =>
      apiFetch<{ data: ScheduleDashboardRow[] }>('/v1/schedules/dashboard', {
        query: {
          tab,
          user_id: userId,
          date_from: dateFrom,
          date_to: dateTo,
        },
      }),
  });

  const rows = query.data?.data ?? [];

  // Build a unique list of days within [dateFrom, dateTo].
  const days = useMemo(() => {
    if (!dateFrom || !dateTo) return [] as string[];
    const start = DateTime.fromISO(dateFrom);
    const end = DateTime.fromISO(dateTo);
    if (!start.isValid || !end.isValid || end < start) return [];
    const out: string[] = [];
    for (let d = start; d <= end; d = d.plus({ days: 1 })) {
      const iso = d.toISODate();
      if (iso) out.push(iso);
    }
    return out;
  }, [dateFrom, dateTo]);

  // Aggregate rows by user.
  const byUser = useMemo(() => {
    const map = new Map<
      string,
      { displayName: string; days: Map<string, ScheduleDashboardRow> }
    >();
    for (const row of rows) {
      let bucket = map.get(row.user_id);
      if (!bucket) {
        bucket = { displayName: row.user_display_name, days: new Map() };
        map.set(row.user_id, bucket);
      }
      bucket.days.set(row.local_date, row);
    }
    return Array.from(map.entries())
      .map(([userId, value]) => ({ userId, ...value }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [rows]);

  if (query.isLoading) {
    return <LoadingSpinner size="md" label="Loading schedule" />;
  }
  if (query.isError) {
    return <ErrorBlock error={query.error} onRetry={() => query.refetch()} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No scheduled hours in this range"
        description="Adjust the date filter or check back once schedules are populated."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-neutral-50 text-[10px] uppercase tracking-wide text-neutral-500">
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 font-medium">
              Employee
            </th>
            {days.map((d) => (
              <th key={d} scope="col" className="px-2 py-2 font-medium">
                {DateTime.fromISO(d).toFormat('ccc dd')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {byUser.map((entry) => (
            <tr key={entry.userId}>
              <th
                scope="row"
                className="sticky left-0 z-10 bg-white px-3 py-2 font-medium text-neutral-900"
              >
                <div className="flex items-center gap-2">
                  <Avatar name={entry.displayName} size="sm" />
                  <span className="whitespace-nowrap">{entry.displayName}</span>
                </div>
              </th>
              {days.map((d) => {
                const cell = entry.days.get(d);
                if (!cell) {
                  return (
                    <td key={d} className="px-2 py-2 text-center text-neutral-300">
                      —
                    </td>
                  );
                }
                const isOverride = cell.source !== 'template';
                return (
                  <td key={d} className="px-2 py-2">
                    <div
                      title={`${cell.scheduled_start}–${cell.scheduled_end} (${cell.scheduled_hours.toFixed(1)}h)${
                        cell.override_reason ? ` · ${cell.override_reason}` : ''
                      }`}
                      className={`flex flex-col gap-0.5 rounded border px-2 py-1 ${
                        isOverride
                          ? 'border-warning-500/40 bg-warning-50 text-warning-700'
                          : 'border-brand-200 bg-brand-50 text-brand-700'
                      }`}
                    >
                      <span className="font-mono text-[11px]">
                        {cell.scheduled_start}–{cell.scheduled_end}
                      </span>
                      <span className="text-[10px]">
                        {cell.scheduled_hours.toFixed(1)}h
                      </span>
                      {isOverride ? (
                        <Badge tone="warning" className="text-[9px]">
                          Override
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IndividualPicker({
  value,
  onChange,
  canPickOthers,
}: {
  value: string;
  onChange: (v: string) => void;
  canPickOthers: boolean;
}) {
  const { data: user } = useCurrentUser();
  const usersQuery = useQuery({
    enabled: canPickOthers,
    queryKey: ['schedule', 'individual-pick'],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });

  if (!canPickOthers) {
    return (
      <p className="mb-3 text-xs text-neutral-500">
        Showing your own schedule. Managers can select team members from the picker.
      </p>
    );
  }

  return (
    <div className="mb-3 max-w-sm">
      <Select
        label="Employee"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={(usersQuery.data?.data ?? []).map((u) => ({
          value: String(u.id),
          label:
            u.id === user?.id
              ? `${u.display_name} (you)`
              : `${u.display_name} (${u.email})`,
        }))}
      />
    </div>
  );
}

function OverrideModal({
  state,
  setState,
  onSubmit,
  allowedScopes,
}: {
  state: OverrideEditorState;
  setState: (next: OverrideEditorState | null) => void;
  onSubmit: () => void;
  allowedScopes: ScheduleOverrideScope[];
}) {
  // Load users + projects for the target pickers. These queries piggy-back on
  // the admin pickers' cache keys so they share data when the user moves
  // between admin pages and the schedule page in the same session.
  const usersQuery = useQuery({
    enabled: allowedScopes.includes('user'),
    queryKey: ['admin', 'users-for-picker'],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });
  const projectsQuery = useQuery({
    enabled: allowedScopes.includes('project'),
    queryKey: ['admin', 'projects-for-picker'],
    queryFn: () =>
      apiFetch<OffsetPaginated<AdminProject>>('/v1/projects', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });

  return (
    <ModalContent
      size="lg"
      title="New schedule override"
      description="Overrides take precedence over the org-wide template for the date range."
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => setState(null)}
            disabled={state.submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={state.submitting}
            onClick={onSubmit}
          >
            Create override
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Scope"
          value={state.scope}
          onChange={(e) =>
            setState({ ...state, scope: e.target.value as ScheduleOverrideScope })
          }
          options={[
            ...(allowedScopes.includes('user')
              ? [{ value: 'user', label: 'User' }]
              : []),
            ...(allowedScopes.includes('project')
              ? [{ value: 'project', label: 'Project' }]
              : []),
            ...(allowedScopes.includes('org')
              ? [{ value: 'org', label: 'Organisation-wide' }]
              : []),
          ]}
        />
        {state.scope === 'user' ? (
          <Select
            label="Target user"
            value={state.userId}
            onChange={(e) => setState({ ...state, userId: e.target.value })}
            placeholder="Select a user"
            options={(usersQuery.data?.data ?? []).map((u) => ({
              value: String(u.id),
              label: `${u.display_name} (${u.email})`,
            }))}
          />
        ) : null}
        {state.scope === 'project' ? (
          <Select
            label="Target project"
            value={state.projectId}
            onChange={(e) => setState({ ...state, projectId: e.target.value })}
            placeholder="Select a project"
            options={(projectsQuery.data?.data ?? []).map((p) => ({
              value: String(p.id),
              label: p.name,
            }))}
          />
        ) : null}
        <Input
          label="Effective from"
          type="date"
          required
          value={state.effectiveFrom}
          onChange={(e) => setState({ ...state, effectiveFrom: e.target.value })}
        />
        <Input
          label="Effective to"
          type="date"
          required
          value={state.effectiveTo}
          onChange={(e) => setState({ ...state, effectiveTo: e.target.value })}
        />
        <Input
          label="Start time (HH:mm)"
          type="time"
          value={state.startTime}
          onChange={(e) => setState({ ...state, startTime: e.target.value })}
        />
        <Input
          label="End time (HH:mm)"
          type="time"
          value={state.endTime}
          onChange={(e) => setState({ ...state, endTime: e.target.value })}
        />
        <Input
          label="Lunch start (HH:mm, optional)"
          type="time"
          value={state.lunchStart}
          onChange={(e) => setState({ ...state, lunchStart: e.target.value })}
        />
        <Input
          label="Lunch end (HH:mm, optional)"
          type="time"
          value={state.lunchEnd}
          onChange={(e) => setState({ ...state, lunchEnd: e.target.value })}
        />
      </div>
      <div className="mt-3">
        <label
          htmlFor="override-reason"
          className="block text-xs font-medium text-neutral-700"
        >
          Reason (optional)
        </label>
        <textarea
          id="override-reason"
          rows={2}
          value={state.reason}
          onChange={(e) => setState({ ...state, reason: e.target.value })}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          placeholder="e.g. Public holiday — half-day"
        />
      </div>
      {state.error ? (
        <p role="alert" className="mt-3 text-xs text-danger-600">
          {state.error}
        </p>
      ) : null}
    </ModalContent>
  );
}
