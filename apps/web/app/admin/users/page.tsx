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
import { Search, ShieldCheck, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch, describeError } from '@/lib/api-client.js';
import { useScope } from '@/lib/rbac.js';
import type {
  OffsetPaginated,
  Role,
  User,
} from '@/lib/api-types.js';
import { COMMON_IANA_TIMEZONES, isKnownTimezone } from '@/lib/tz-list.js';
import { RolesCell, roleSet } from './roles-cell.js';

const ALL_ROLES: Role[] = ['admin', 'finmgr', 'manager', 'employee'];
const PAGE_SIZE = 50;

interface RolesEditorState {
  user: User;
  draft: Set<Role>;
  submitting: boolean;
  error?: string;
}

interface ProfileEditorState {
  user: User;
  displayName: string;
  timezone: string;
  customTimezone: string;
  submitting: boolean;
  error?: string;
}

export default function AdminUsersPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [rolesEditor, setRolesEditor] = useState<RolesEditorState | null>(null);
  const [profileEditor, setProfileEditor] = useState<ProfileEditorState | null>(null);

  // Admin-only redirect.
  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.isAdmin) {
      toast.info('Restricted', 'User management is available to Admin only.');
      router.replace('/timesheets');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.isAdmin]);

  // Debounce the search input by 300ms so we don't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Reset to page 1 whenever the filter changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, roleFilter]);

  const usersQuery = useQuery({
    enabled: !!scope.user && scope.isAdmin,
    queryKey: ['admin', 'users', { page, search: debouncedSearch, role: roleFilter }],
    queryFn: () =>
      apiFetch<OffsetPaginated<User>>('/v1/users', {
        query: {
          page,
          page_size: PAGE_SIZE,
          search: debouncedSearch || undefined,
          role: roleFilter || undefined,
        },
      }),
    placeholderData: (prev) => prev,
  });

  const items = usersQuery.data?.data ?? [];
  const totalCount = usersQuery.data?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const assignRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      apiFetch<User>(`/v1/users/${userId}/roles`, {
        method: 'POST',
        body: { role },
      }),
  });

  const revokeRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      apiFetch<void>(`/v1/users/${userId}/roles/${role}`, { method: 'DELETE' }),
  });

  const patchUserMutation = useMutation({
    mutationFn: ({
      userId,
      body,
    }: {
      userId: string;
      body: { display_name?: string; timezone?: string };
    }) =>
      apiFetch<User>(`/v1/users/${userId}`, {
        method: 'PATCH',
        body,
      }),
  });

  async function submitRolesEditor() {
    if (!rolesEditor) return;
    const { user, draft } = rolesEditor;
    const current = roleSet(user);
    const toAdd = [...draft].filter((r) => !current.has(r));
    const toRemove = [...current].filter((r) => !draft.has(r));

    if (toAdd.length === 0 && toRemove.length === 0) {
      setRolesEditor(null);
      return;
    }

    setRolesEditor({ ...rolesEditor, submitting: true, error: undefined });
    try {
      for (const role of toAdd) {
        await assignRoleMutation.mutateAsync({ userId: user.id, role });
      }
      for (const role of toRemove) {
        await revokeRoleMutation.mutateAsync({ userId: user.id, role });
      }
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success('Roles updated', `${user.display_name}'s roles were saved.`);
      setRolesEditor(null);
    } catch (err) {
      setRolesEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  async function submitProfileEditor() {
    if (!profileEditor) return;
    const { user, displayName, timezone, customTimezone } = profileEditor;
    const finalTz =
      timezone === '__custom__' ? customTimezone.trim() : timezone.trim();
    if (!finalTz) {
      setProfileEditor({ ...profileEditor, error: 'Timezone is required.' });
      return;
    }
    if (!displayName.trim()) {
      setProfileEditor({ ...profileEditor, error: 'Display name is required.' });
      return;
    }
    setProfileEditor({ ...profileEditor, submitting: true, error: undefined });
    try {
      await patchUserMutation.mutateAsync({
        userId: user.id,
        body: { display_name: displayName.trim(), timezone: finalTz },
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success('Profile updated', `${displayName} was saved.`);
      setProfileEditor(null);
    } catch (err) {
      setProfileEditor((prev) =>
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
        title="User management"
        description="Provision roles after employees self-register via OIDC. Edit profile fields below."
        actions={
          <Button variant="primary" disabled aria-label="Add user (disabled — users self-register via OIDC)">
            Add user
          </Button>
        }
      />

      <Card title="Users" padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <div className="min-w-[240px] flex-1">
            <Input
              placeholder="Search by name or email"
              iconLeft={<Search className="h-4 w-4" aria-hidden="true" />}
              aria-label="Search users"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-48">
            <Select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as Role | '')}
              placeholder="All roles"
              options={[
                { value: '', label: 'All roles' },
                ...ALL_ROLES.map((r) => ({ value: r, label: roleLabel(r) })),
              ]}
            />
          </div>
        </div>

        {usersQuery.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading users" />
          </div>
        ) : usersQuery.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={usersQuery.error} onRetry={() => usersQuery.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No users yet"
              description="They appear after their first OIDC sign-in."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Roles</TH>
                <TH>Timezone</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((user) => (
                <TR key={user.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={user.display_name} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-neutral-900">
                          {user.display_name}
                        </div>
                        <div className="truncate text-xs text-neutral-500">{user.email}</div>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <RolesCell user={user} />
                  </TD>
                  <TD className="font-mono text-xs">{user.timezone}</TD>
                  <TD>
                    {user.is_active ? (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Inactive
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setRolesEditor({
                            user,
                            draft: roleSet(user),
                            submitting: false,
                          })
                        }
                      >
                        Edit roles
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<UserCog className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() =>
                          setProfileEditor({
                            user,
                            displayName: user.display_name,
                            timezone: isKnownTimezone(user.timezone)
                              ? user.timezone
                              : '__custom__',
                            customTimezone: isKnownTimezone(user.timezone)
                              ? ''
                              : user.timezone,
                            submitting: false,
                          })
                        }
                      >
                        Edit profile
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {totalCount > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-2 text-xs text-neutral-500">
            <span>
              Page {page} of {totalPages} ({totalCount} users)
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {/* Roles editor modal */}
      <Modal
        open={!!rolesEditor}
        onOpenChange={(open) => {
          if (!open) setRolesEditor(null);
        }}
      >
        {rolesEditor ? (
          <ModalContent
            title={`Edit roles — ${rolesEditor.user.display_name}`}
            description="Multi-select. Changes apply via POST/DELETE per role on save."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setRolesEditor(null)}
                  disabled={rolesEditor.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={rolesEditor.submitting}
                  onClick={() => void submitRolesEditor()}
                >
                  Save roles
                </Button>
              </>
            }
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Roles</legend>
              {ALL_ROLES.map((role) => {
                const checked = rolesEditor.draft.has(role);
                return (
                  <label
                    key={role}
                    className="flex items-start gap-2 rounded-md border border-neutral-200 px-3 py-2 hover:bg-neutral-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setRolesEditor((prev) => {
                          if (!prev) return prev;
                          const next = new Set(prev.draft);
                          if (e.target.checked) next.add(role);
                          else next.delete(role);
                          return { ...prev, draft: next };
                        });
                      }}
                      className="mt-1 h-4 w-4 rounded border-neutral-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    <span>
                      <span className="block text-sm font-medium capitalize text-neutral-900">
                        {role}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {roleDescription(role)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {rolesEditor.error ? (
              <p role="alert" className="mt-3 text-xs text-danger-600">
                {rolesEditor.error}
              </p>
            ) : null}
          </ModalContent>
        ) : null}
      </Modal>

      {/* Profile editor modal */}
      <Modal
        open={!!profileEditor}
        onOpenChange={(open) => {
          if (!open) setProfileEditor(null);
        }}
      >
        {profileEditor ? (
          <ModalContent
            title={`Edit profile — ${profileEditor.user.display_name}`}
            description="Display name and IANA timezone. Use the custom option for unlisted zones."
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setProfileEditor(null)}
                  disabled={profileEditor.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={profileEditor.submitting}
                  onClick={() => void submitProfileEditor()}
                >
                  Save profile
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Input
                label="Display name"
                value={profileEditor.displayName}
                onChange={(e) =>
                  setProfileEditor((prev) =>
                    prev ? { ...prev, displayName: e.target.value } : prev,
                  )
                }
                required
              />
              <Select
                label="Timezone"
                value={profileEditor.timezone}
                onChange={(e) =>
                  setProfileEditor((prev) =>
                    prev ? { ...prev, timezone: e.target.value } : prev,
                  )
                }
                options={[
                  ...COMMON_IANA_TIMEZONES,
                  { value: '__custom__', label: 'Custom (enter IANA name)' },
                ]}
              />
              {profileEditor.timezone === '__custom__' ? (
                <Input
                  label="Custom IANA timezone"
                  placeholder="e.g. Africa/Windhoek"
                  hint="Must be a valid IANA timezone identifier."
                  value={profileEditor.customTimezone}
                  onChange={(e) =>
                    setProfileEditor((prev) =>
                      prev ? { ...prev, customTimezone: e.target.value } : prev,
                    )
                  }
                />
              ) : null}
              {profileEditor.error ? (
                <p role="alert" className="text-xs text-danger-600">
                  {profileEditor.error}
                </p>
              ) : null}
            </div>
          </ModalContent>
        ) : null}
      </Modal>
    </div>
  );
}

function roleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'finmgr':
      return 'Financial Manager';
    case 'manager':
      return 'Manager';
    case 'employee':
      return 'Employee';
  }
}

function roleDescription(role: Role): string {
  switch (role) {
    case 'admin':
      return 'Full administrative access. Can manage users, roles, projects, and rates.';
    case 'finmgr':
      return 'Stage-2 timesheet approver. Manages cost & billable rates.';
    case 'manager':
      return 'Stage-1 approver for their anchored team and projects.';
    case 'employee':
      return 'Logs own time and books own leave.';
  }
}

