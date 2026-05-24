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
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@harvoost/ui';
import { ListChecks, Pencil, Plus, Search, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ApiError, apiFetch, describeError } from '@/lib/api-client.js';
import { useScope } from '@/lib/rbac.js';
import {
  adminTasksKey,
  buildTaskPatch,
  createProjectTask,
  fetchAdminProjectTasks,
  isTaskNameExistsError,
  pickerTasksKey,
  updateProjectTask,
} from '@/lib/project-tasks.js';
import type {
  AdminProject,
  BillingMode,
  Client,
  OffsetPaginated,
  ProjectManagerAnchor,
  ProjectMember,
  ProjectTask,
  User,
} from '@/lib/api-types.js';

const BILLING_MODES: Array<{ value: BillingMode; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'fixed_fee', label: 'Fixed fee' },
  { value: 'non_billable', label: 'Non-billable' },
];

interface ProjectEditorState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  code: string;
  clientId: string;
  billingMode: BillingMode;
  hoursBudget: string;
  fixedFeeAmount: string;
  currency: string;
  submitting: boolean;
  error?: string;
}

type DrawerKind = 'members' | 'managers' | 'tasks';

interface DrawerState {
  kind: DrawerKind;
  project: AdminProject;
}

interface ArchiveConfirmState {
  project: AdminProject;
  submitting: boolean;
  error?: string;
}

export default function AdminProjectsPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [editor, setEditor] = useState<ProjectEditorState | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<ArchiveConfirmState | null>(null);

  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.isAdmin) {
      toast.info('Restricted', 'Project management is available to Admin only.');
      router.replace('/timesheets');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.isAdmin]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const projectsQuery = useQuery({
    enabled: !!scope.user && scope.isAdmin,
    queryKey: ['admin', 'projects', { search: debouncedSearch }],
    queryFn: () =>
      apiFetch<OffsetPaginated<AdminProject>>('/v1/projects', {
        query: { page: 1, page_size: 100, search: debouncedSearch || undefined },
      }),
  });

  const clientsQuery = useQuery({
    enabled: !!scope.user && scope.isAdmin,
    queryKey: ['admin', 'clients-for-picker'],
    queryFn: () =>
      apiFetch<OffsetPaginated<Client>>('/v1/clients', {
        query: { page: 1, page_size: 100, is_active: true },
      }),
  });

  const items = projectsQuery.data?.data ?? [];

  const createProjectMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<AdminProject>('/v1/projects', { method: 'POST', body }),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiFetch<AdminProject>(`/v1/projects/${id}`, { method: 'PATCH', body }),
  });

  async function submitEditor() {
    if (!editor) return;
    if (!editor.name.trim()) {
      setEditor({ ...editor, error: 'Name is required.' });
      return;
    }
    if (!editor.clientId) {
      setEditor({ ...editor, error: 'Client is required.' });
      return;
    }
    setEditor({ ...editor, submitting: true, error: undefined });
    try {
      const body: Record<string, unknown> = {
        name: editor.name.trim(),
        billing_mode: editor.billingMode,
        currency: editor.currency.trim() || 'ZAR',
      };
      if (editor.code.trim()) body.code = editor.code.trim();
      if (editor.hoursBudget.trim()) {
        const parsed = Number(editor.hoursBudget);
        if (Number.isFinite(parsed) && parsed >= 0) body.hours_budget = parsed;
      }
      if (editor.fixedFeeAmount.trim()) {
        const parsed = Number(editor.fixedFeeAmount);
        if (Number.isFinite(parsed) && parsed >= 0) body.fixed_fee_amount = parsed;
      }
      if (editor.mode === 'create') {
        // client_id is a string on the wire (API CreateProjectSchema: z.string());
        // editor.clientId already holds the picker's String(client.id) value.
        body.client_id = editor.clientId;
        await createProjectMutation.mutateAsync(body);
        toast.success('Project created', editor.name.trim());
      } else if (editor.id !== undefined) {
        await updateProjectMutation.mutateAsync({ id: editor.id, body });
        toast.success('Project updated', editor.name.trim());
      }
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      setEditor(null);
    } catch (err) {
      setEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  const archiveProjectMutation = useMutation({
    mutationFn: (id: string) =>
      // PATCH is_active=false is the canonical archive path per openapi.yaml
      // /v1/projects/{project_id}.
      apiFetch<AdminProject>(`/v1/projects/${id}`, {
        method: 'PATCH',
        body: { is_active: false },
      }),
  });

  async function submitArchive() {
    if (!archiveConfirm) return;
    setArchiveConfirm({ ...archiveConfirm, submitting: true, error: undefined });
    try {
      await archiveProjectMutation.mutateAsync(archiveConfirm.project.id);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      toast.success('Project archived', archiveConfirm.project.name);
      setArchiveConfirm(null);
    } catch (err) {
      setArchiveConfirm((prev) =>
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
  if (!scope.isAdmin) return null;

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Create projects, assign members, and assign managers."
        actions={
          <Button
            variant="primary"
            iconLeft={<Plus className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              setEditor({
                mode: 'create',
                name: '',
                code: '',
                clientId: '',
                billingMode: 'hourly',
                hoursBudget: '',
                fixedFeeAmount: '',
                currency: 'ZAR',
                submitting: false,
              })
            }
          >
            New project
          </Button>
        }
      />

      <Card title="Projects" padded={false}>
        <div className="border-b border-neutral-100 px-4 py-3">
          <div className="max-w-md">
            <Input
              placeholder="Search projects"
              iconLeft={<Search className="h-4 w-4" aria-hidden="true" />}
              aria-label="Search projects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {projectsQuery.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading projects" />
          </div>
        ) : projectsQuery.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock
              error={projectsQuery.error}
              onRetry={() => projectsQuery.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState title="No projects yet" description="Create your first project." />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Project</TH>
                <TH>Code</TH>
                <TH>Client</TH>
                <TH>Billing</TH>
                <TH className="text-right">Members</TH>
                <TH className="text-right">Managers</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((project) => (
                <TR key={project.id}>
                  <TD className="font-medium text-neutral-900">{project.name}</TD>
                  <TD className="font-mono text-xs">{project.code ?? '—'}</TD>
                  <TD className="text-neutral-700">{project.client_name ?? '—'}</TD>
                  <TD>
                    <Badge tone="info">{billingLabel(project.billing_mode)}</Badge>
                  </TD>
                  <TD className="text-right font-mono text-xs">
                    {project.members_count ?? '—'}
                  </TD>
                  <TD className="text-right font-mono text-xs">
                    {project.managers_count ?? '—'}
                  </TD>
                  <TD>
                    {project.is_active ? (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Archived
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            mode: 'edit',
                            id: project.id,
                            name: project.name,
                            code: project.code ?? '',
                            clientId: String(project.client_id),
                            billingMode: project.billing_mode,
                            hoursBudget:
                              project.hours_budget != null
                                ? String(project.hours_budget)
                                : '',
                            fixedFeeAmount:
                              project.fixed_fee_amount != null
                                ? String(project.fixed_fee_amount)
                                : '',
                            currency: project.currency,
                            submitting: false,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<Users className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setDrawer({ kind: 'members', project })
                        }
                      >
                        Members
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<UserPlus className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setDrawer({ kind: 'managers', project })
                        }
                      >
                        Managers
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => setDrawer({ kind: 'tasks', project })}
                      >
                        Tasks
                      </Button>
                      {project.is_active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setArchiveConfirm({ project, submitting: false })
                          }
                        >
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Project editor modal */}
      <Modal
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        {editor ? (
          <ModalContent
            size="lg"
            title={editor.mode === 'create' ? 'New project' : 'Edit project'}
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
                  {editor.mode === 'create' ? 'Create project' : 'Save changes'}
                </Button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Name"
                required
                value={editor.name}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, name: e.target.value } : p))
                }
              />
              <Input
                label="Project code"
                placeholder="ATL"
                value={editor.code}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, code: e.target.value } : p))
                }
              />
              <Select
                label="Client"
                required
                value={editor.clientId}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, clientId: e.target.value } : p))
                }
                disabled={editor.mode === 'edit'}
                placeholder="Select a client"
                options={(clientsQuery.data?.data ?? []).map((c) => ({
                  value: String(c.id),
                  label: c.name,
                }))}
              />
              <Select
                label="Billing mode"
                value={editor.billingMode}
                onChange={(e) =>
                  setEditor((p) =>
                    p ? { ...p, billingMode: e.target.value as BillingMode } : p,
                  )
                }
                options={BILLING_MODES}
              />
              <Input
                label="Currency (ISO 4217)"
                value={editor.currency}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, currency: e.target.value } : p))
                }
              />
              <Input
                label="Hours budget"
                type="number"
                min={0}
                step="0.1"
                value={editor.hoursBudget}
                onChange={(e) =>
                  setEditor((p) => (p ? { ...p, hoursBudget: e.target.value } : p))
                }
              />
              {editor.billingMode === 'fixed_fee' ? (
                <Input
                  label="Fixed fee amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={editor.fixedFeeAmount}
                  onChange={(e) =>
                    setEditor((p) =>
                      p ? { ...p, fixedFeeAmount: e.target.value } : p,
                    )
                  }
                />
              ) : null}
            </div>
            {editor.error ? (
              <p role="alert" className="mt-3 text-xs text-danger-600">
                {editor.error}
              </p>
            ) : null}
            {editor.mode === 'create' ? (
              <p className="mt-3 text-xs text-neutral-500">
                After creating the project, use the Members / Managers buttons on the
                project row to assign people.
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>

      {/* Members / Managers drawer (rendered as a Modal sized lg) */}
      <Modal
        open={!!drawer}
        onOpenChange={(open) => {
          if (!open) setDrawer(null);
        }}
      >
        {drawer ? (
          <ModalContent
            size="lg"
            title={`${drawerTitle(drawer.kind)} — ${drawer.project.name}`}
            description={drawerDescription(drawer.kind)}
            footer={
              <Button variant="primary" onClick={() => setDrawer(null)}>
                Done
              </Button>
            }
          >
            {drawer.kind === 'members' ? (
              <MembersDrawer projectId={drawer.project.id} />
            ) : drawer.kind === 'managers' ? (
              <ManagersDrawer projectId={drawer.project.id} />
            ) : (
              <TasksDrawer projectId={drawer.project.id} />
            )}
          </ModalContent>
        ) : null}
      </Modal>

      {/* Archive confirmation */}
      <Modal
        open={!!archiveConfirm}
        onOpenChange={(open) => {
          if (!open) setArchiveConfirm(null);
        }}
      >
        {archiveConfirm ? (
          <ModalContent
            title="Archive project?"
            description={`This sets ${archiveConfirm.project.name} to inactive. Historical time entries are preserved.`}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setArchiveConfirm(null)}
                  disabled={archiveConfirm.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={archiveConfirm.submitting}
                  onClick={() => void submitArchive()}
                >
                  Archive project
                </Button>
              </>
            }
          >
            {archiveConfirm.error ? (
              <p role="alert" className="text-xs text-danger-600">
                {archiveConfirm.error}
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>
    </div>
  );
}

function MembersDrawer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [addUserId, setAddUserId] = useState('');

  const membersQuery = useQuery({
    queryKey: ['admin', 'projects', projectId, 'members'],
    queryFn: () =>
      apiFetch<OffsetPaginated<ProjectMember>>(
        `/v1/projects/${projectId}/members`,
      ),
  });

  const usersQuery = useQuery({
    queryKey: ['admin', 'users-for-picker'],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: { page: 1, page_size: 200, is_active: true },
      }),
  });

  const addMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<ProjectMember>(`/v1/projects/${projectId}/members`, {
        method: 'POST',
        body: { user_id: userId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['admin', 'projects', projectId, 'members'],
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      setAddUserId('');
      toast.success('Member added');
    },
    onError: (err) => toast.error('Could not add member', describeError(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/v1/projects/${projectId}/members/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['admin', 'projects', projectId, 'members'],
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      toast.success('Member removed');
    },
    onError: (err) => toast.error('Could not remove member', describeError(err)),
  });

  const members = membersQuery.data?.data ?? [];
  const memberIds = new Set(members.map((m) => m.user_id));
  const availableUsers = (usersQuery.data?.data ?? []).filter(
    (u) => !memberIds.has(u.id),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            label="Add member"
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            placeholder="Select a user"
            options={availableUsers.map((u) => ({
              value: String(u.id),
              label: `${u.display_name} (${u.email})`,
            }))}
          />
        </div>
        <Button
          variant="primary"
          disabled={!addUserId || addMutation.isPending}
          loading={addMutation.isPending}
          onClick={() => addMutation.mutate(addUserId)}
        >
          Add
        </Button>
      </div>

      {membersQuery.isLoading ? (
        <LoadingSpinner size="sm" label="Loading members" />
      ) : membersQuery.isError ? (
        <ErrorBlock error={membersQuery.error} onRetry={() => membersQuery.refetch()} />
      ) : members.length === 0 ? (
        <EmptyState title="No members yet" description="Add people from the picker above." />
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <Avatar name={m.user_display_name ?? `User #${m.user_id}`} size="sm" />
                <div>
                  <div className="text-sm font-medium text-neutral-900">
                    {m.user_display_name ?? `User #${m.user_id}`}
                  </div>
                  {m.user_email ? (
                    <div className="text-xs text-neutral-500">{m.user_email}</div>
                  ) : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                aria-label={`Remove ${m.user_display_name ?? `user ${m.user_id}`}`}
                onClick={() => removeMutation.mutate(m.user_id)}
                disabled={removeMutation.isPending}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ManagersDrawer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [addManagerId, setAddManagerId] = useState('');

  const managersQuery = useQuery({
    queryKey: ['admin', 'projects', projectId, 'managers'],
    queryFn: () =>
      apiFetch<OffsetPaginated<ProjectManagerAnchor>>(
        `/v1/projects/${projectId}/managers`,
      ),
  });

  // Only managers/admins can be assigned as project managers.
  const usersQuery = useQuery({
    queryKey: ['admin', 'managers-for-picker'],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: { page: 1, page_size: 200, role: 'manager', is_active: true },
      }),
  });

  const addMutation = useMutation({
    mutationFn: (managerId: string) =>
      apiFetch<ProjectManagerAnchor>(`/v1/projects/${projectId}/managers`, {
        method: 'POST',
        body: { manager_id: managerId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['admin', 'projects', projectId, 'managers'],
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      setAddManagerId('');
      toast.success('Manager anchored');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Already anchored', 'That manager is already anchored to this project.');
        return;
      }
      toast.error('Could not anchor manager', describeError(err));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (managerId: string) =>
      apiFetch<void>(`/v1/projects/${projectId}/managers/${managerId}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['admin', 'projects', projectId, 'managers'],
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'projects'] });
      toast.success('Manager unanchored');
    },
    onError: (err) => toast.error('Could not unanchor manager', describeError(err)),
  });

  const managers = managersQuery.data?.data ?? [];
  const managerIds = new Set(managers.map((m) => m.manager_id));
  const availableUsers = (usersQuery.data?.data ?? []).filter(
    (u) => !managerIds.has(u.id),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            label="Add manager"
            value={addManagerId}
            onChange={(e) => setAddManagerId(e.target.value)}
            placeholder="Select a manager"
            options={availableUsers.map((u) => ({
              value: String(u.id),
              label: `${u.display_name} (${u.email})`,
            }))}
          />
        </div>
        <Button
          variant="primary"
          disabled={!addManagerId || addMutation.isPending}
          loading={addMutation.isPending}
          onClick={() => addMutation.mutate(addManagerId)}
        >
          Anchor
        </Button>
      </div>

      {managersQuery.isLoading ? (
        <LoadingSpinner size="sm" label="Loading managers" />
      ) : managersQuery.isError ? (
        <ErrorBlock error={managersQuery.error} onRetry={() => managersQuery.refetch()} />
      ) : managers.length === 0 ? (
        <EmptyState
          title="No managers anchored"
          description="Anchored managers see all members and time entries on this project."
        />
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {managers.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <Avatar name={m.manager_display_name ?? `Manager #${m.manager_id}`} size="sm" />
                <div>
                  <div className="text-sm font-medium text-neutral-900">
                    {m.manager_display_name ?? `Manager #${m.manager_id}`}
                  </div>
                  {m.manager_email ? (
                    <div className="text-xs text-neutral-500">{m.manager_email}</div>
                  ) : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                aria-label={`Unanchor ${m.manager_display_name ?? `manager ${m.manager_id}`}`}
                onClick={() => removeMutation.mutate(m.manager_id)}
                disabled={removeMutation.isPending}
              >
                Unanchor
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function drawerTitle(kind: DrawerKind): string {
  switch (kind) {
    case 'members':
      return 'Members';
    case 'managers':
      return 'Managers';
    case 'tasks':
      return 'Tasks';
  }
}

function drawerDescription(kind: DrawerKind): string {
  switch (kind) {
    case 'members':
      return 'People assigned to this project. Removing a member preserves their historical time entries.';
    case 'managers':
      return 'Managers anchored to this project. Anchored managers see all members and time entries.';
    case 'tasks':
      return 'Categories used to log time on this project. Archiving a task hides it from the time-entry picker but preserves historical entries.';
  }
}

// FEAT-003 (GitHub #16) — per-task editing state held in the drawer. A task is
// either being added (the top control) or edited inline (one row at a time).
interface TaskEditState {
  name: string;
  isBillable: boolean;
}

const BILLABLE_OPTIONS = [
  { value: 'true', label: 'Billable' },
  { value: 'false', label: 'Non-billable' },
];

/**
 * Admin Tasks drawer. Lists ALL tasks (active + archived) for the project via
 * GET /v1/projects/{id}/tasks (no is_active filter). Supports add, inline
 * rename + billability edit, archive, and reactivate. Every successful write
 * invalidates the admin list key AND the time-entry picker key (AC-8) so the
 * NewEntryForm / StartTimerControl pickers reflect the change.
 */
function TasksDrawer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [newName, setNewName] = useState('');
  const [newBillable, setNewBillable] = useState(true);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  // taskId currently in inline-edit mode → its draft values.
  const [editing, setEditing] = useState<{ id: string; draft: TaskEditState } | null>(
    null,
  );
  const [editError, setEditError] = useState<string | undefined>(undefined);

  const tasksQuery = useQuery({
    queryKey: adminTasksKey(projectId),
    queryFn: () => fetchAdminProjectTasks(projectId),
  });

  // Invalidate the admin list AND the time-entry picker (both NewEntryForm and
  // StartTimerControl read `['projects', projectId, 'tasks']`) after any write.
  async function invalidateAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: adminTasksKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: pickerTasksKey(projectId) }),
    ]);
  }

  // Map the API's duplicate-active-name error to a friendly sentence. The REAL
  // envelope is HTTP 400 with top-level code VALIDATION_FAILED and the stable
  // TASK_NAME_EXISTS code nested at details.code (clients/billable-rates
  // precedent) — isTaskNameExistsError narrows for that plus the 422/409 +
  // top-level-code forward-compat shapes.
  function describeTaskError(err: unknown): string {
    if (isTaskNameExistsError(err)) {
      return 'A task with that name already exists in this project.';
    }
    return describeError(err);
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createProjectTask(projectId, {
        name: newName.trim(),
        is_billable: newBillable,
      }),
    onSuccess: async (task) => {
      await invalidateAll();
      setNewName('');
      setNewBillable(true);
      setAddError(undefined);
      toast.success('Task added', task.name);
    },
    onError: (err) => setAddError(describeTaskError(err)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: Parameters<typeof updateProjectTask>[2] }) =>
      updateProjectTask(projectId, taskId, body),
  });

  function submitAdd() {
    if (!newName.trim()) {
      setAddError('Name is required.');
      return;
    }
    setAddError(undefined);
    createMutation.mutate();
  }

  async function submitEdit() {
    if (!editing) return;
    const current = tasks.find((t) => t.id === editing.id);
    if (!current) {
      setEditing(null);
      return;
    }
    if (!editing.draft.name.trim()) {
      setEditError('Name is required.');
      return;
    }
    // Only send fields that changed — an empty PATCH is a 400 server-side. If
    // nothing changed, just close the editor without a request.
    const patch = buildTaskPatch(current, {
      name: editing.draft.name,
      isBillable: editing.draft.isBillable,
    });
    if (!patch) {
      setEditing(null);
      setEditError(undefined);
      return;
    }
    try {
      await updateMutation.mutateAsync({ taskId: editing.id, body: patch });
      await invalidateAll();
      toast.success('Task updated', editing.draft.name.trim());
      setEditing(null);
      setEditError(undefined);
    } catch (err) {
      setEditError(describeTaskError(err));
    }
  }

  async function setActive(task: ProjectTask, isActive: boolean) {
    try {
      await updateMutation.mutateAsync({
        taskId: task.id,
        body: { is_active: isActive },
      });
      await invalidateAll();
      toast.success(isActive ? 'Task reactivated' : 'Task archived', task.name);
    } catch (err) {
      // Reactivation can collide with an existing active name (AC-6).
      toast.error(
        isActive ? 'Could not reactivate task' : 'Could not archive task',
        describeTaskError(err),
      );
    }
  }

  const tasks = tasksQuery.data?.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* Add task control */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Add task"
            placeholder="e.g. Development"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitAdd();
              }
            }}
          />
        </div>
        <div className="w-40">
          <Select
            label="Billing"
            aria-label="Billing for new task"
            value={String(newBillable)}
            onChange={(e) => setNewBillable(e.target.value === 'true')}
            options={BILLABLE_OPTIONS}
          />
        </div>
        <Button
          variant="primary"
          disabled={!newName.trim() || createMutation.isPending}
          loading={createMutation.isPending}
          onClick={submitAdd}
        >
          Add
        </Button>
      </div>
      {addError ? (
        <p role="alert" className="text-xs text-danger-600">
          {addError}
        </p>
      ) : null}

      {tasksQuery.isLoading ? (
        <LoadingSpinner size="sm" label="Loading tasks" />
      ) : tasksQuery.isError ? (
        <ErrorBlock error={tasksQuery.error} onRetry={() => tasksQuery.refetch()} />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          description="Add a task above so time can be categorized on this project."
        />
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {tasks.map((task) => {
            const isEditing = editing?.id === task.id;
            return (
              <li key={task.id} className="px-3 py-2">
                {isEditing && editing ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Input
                          label="Task name"
                          aria-label={`Rename ${task.name}`}
                          value={editing.draft.name}
                          onChange={(e) =>
                            setEditing((p) =>
                              p ? { ...p, draft: { ...p.draft, name: e.target.value } } : p,
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void submitEdit();
                            }
                          }}
                        />
                      </div>
                      <div className="w-40">
                        <Select
                          label="Billing"
                          aria-label={`Billing for ${task.name}`}
                          value={String(editing.draft.isBillable)}
                          onChange={(e) =>
                            setEditing((p) =>
                              p
                                ? {
                                    ...p,
                                    draft: {
                                      ...p.draft,
                                      isBillable: e.target.value === 'true',
                                    },
                                  }
                                : p,
                            )
                          }
                          options={BILLABLE_OPTIONS}
                        />
                      </div>
                    </div>
                    {editError ? (
                      <p role="alert" className="text-xs text-danger-600">
                        {editError}
                      </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(null);
                          setEditError(undefined);
                        }}
                        disabled={updateMutation.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={updateMutation.isPending}
                        disabled={!editing.draft.name.trim()}
                        onClick={() => void submitEdit()}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900">
                        {task.name}
                      </span>
                      <Badge tone={task.is_billable ? 'brand' : 'neutral'}>
                        {task.is_billable ? 'Billable' : 'Non-billable'}
                      </Badge>
                      {task.is_active ? (
                        <Badge tone="success" dot>
                          Active
                        </Badge>
                      ) : (
                        <Badge tone="neutral" dot>
                          Archived
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                        aria-label={`Edit ${task.name}`}
                        onClick={() => {
                          setEditing({
                            id: task.id,
                            draft: { name: task.name, isBillable: task.is_billable },
                          });
                          setEditError(undefined);
                        }}
                        disabled={updateMutation.isPending}
                      >
                        Edit
                      </Button>
                      {task.is_active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Archive ${task.name}`}
                          onClick={() => void setActive(task, false)}
                          disabled={updateMutation.isPending}
                        >
                          Archive
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Reactivate ${task.name}`}
                          onClick={() => void setActive(task, true)}
                          disabled={updateMutation.isPending}
                        >
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function billingLabel(mode: BillingMode): string {
  switch (mode) {
    case 'hourly':
      return 'Hourly';
    case 'fixed_fee':
      return 'Fixed fee';
    case 'non_billable':
      return 'Non-billable';
  }
}
