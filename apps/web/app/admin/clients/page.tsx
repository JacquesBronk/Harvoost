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
  useToast,
} from '@harvoost/ui';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { ApiError, apiFetch, describeError } from '@/lib/api-client.js';
import { useScope } from '@/lib/rbac.js';
import type { Client, OffsetPaginated } from '@/lib/api-types.js';

// Common ISO 4217 currencies. Free-text entry is allowed in the modal for any
// currency not in this dropdown.
const COMMON_CURRENCIES = ['ZAR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY'];

interface ClientEditorState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  contact: string;
  currency: string;
  submitting: boolean;
  error?: string;
}

interface DeleteConfirmState {
  client: Client;
  submitting: boolean;
  error?: string;
}

export default function AdminClientsPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [editor, setEditor] = useState<ClientEditorState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);

  // Admin or FinMgr only.
  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.canSeeFinancialData) {
      toast.info('Restricted', 'Client management is available to Admin and FinMgr.');
      router.replace('/timesheets');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.canSeeFinancialData]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const clientsQuery = useQuery({
    enabled: !!scope.user && scope.canSeeFinancialData,
    queryKey: ['admin', 'clients', { search: debouncedSearch }],
    queryFn: () =>
      apiFetch<OffsetPaginated<Client>>('/v1/clients', {
        query: { page: 1, page_size: 100, search: debouncedSearch || undefined },
      }),
  });

  const items = clientsQuery.data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (body: { name: string; contact?: string; currency?: string }) =>
      apiFetch<Client>('/v1/clients', { method: 'POST', body }),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { name?: string; contact?: string; currency?: string };
    }) => apiFetch<Client>(`/v1/clients/${id}`, { method: 'PATCH', body }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/v1/clients/${id}`, { method: 'DELETE' }),
  });

  async function submitEditor() {
    if (!editor) return;
    if (!editor.name.trim()) {
      setEditor({ ...editor, error: 'Name is required.' });
      return;
    }
    setEditor({ ...editor, submitting: true, error: undefined });
    try {
      // NOTE: contact + currency are sent best-effort; the backend may ignore
      // them until the openapi.yaml schema is extended in v1.0.1. Name is the
      // only currently-required field.
      const body = {
        name: editor.name.trim(),
        contact: editor.contact.trim() || undefined,
        currency: editor.currency.trim() || undefined,
      };
      if (editor.mode === 'create') {
        await createMutation.mutateAsync(body);
      } else if (editor.id !== undefined) {
        await updateMutation.mutateAsync({ id: editor.id, body });
      }
      await queryClient.invalidateQueries({ queryKey: ['admin', 'clients'] });
      toast.success(
        editor.mode === 'create' ? 'Client created' : 'Client updated',
        editor.name.trim(),
      );
      setEditor(null);
    } catch (err) {
      setEditor((prev) =>
        prev ? { ...prev, submitting: false, error: describeError(err) } : prev,
      );
    }
  }

  async function submitDelete() {
    if (!deleteConfirm) return;
    setDeleteConfirm({ ...deleteConfirm, submitting: true, error: undefined });
    try {
      await deleteMutation.mutateAsync(deleteConfirm.client.id);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'clients'] });
      toast.success('Client archived', deleteConfirm.client.name);
      setDeleteConfirm(null);
    } catch (err) {
      // 409 means projects still reference this client.
      let friendly = describeError(err);
      if (err instanceof ApiError && err.status === 409) {
        friendly =
          'Cannot delete — projects still reference this client. Archive the projects first.';
      }
      setDeleteConfirm((prev) =>
        prev ? { ...prev, submitting: false, error: friendly } : prev,
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
  if (!scope.canSeeFinancialData) return null;

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Manage the clients used by your projects."
        actions={
          <Button
            variant="primary"
            iconLeft={<Plus className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              setEditor({
                mode: 'create',
                name: '',
                contact: '',
                currency: 'ZAR',
                submitting: false,
              })
            }
          >
            New client
          </Button>
        }
      />

      <Card title="Clients" padded={false}>
        <div className="border-b border-neutral-100 px-4 py-3">
          <div className="max-w-md">
            <Input
              placeholder="Search clients"
              iconLeft={<Search className="h-4 w-4" aria-hidden="true" />}
              aria-label="Search clients"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {clientsQuery.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading clients" />
          </div>
        ) : clientsQuery.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock error={clientsQuery.error} onRetry={() => clientsQuery.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No clients yet"
              description="Create a client to associate projects with."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH className="text-right">Projects</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((client) => (
                <TR key={client.id}>
                  <TD className="font-medium text-neutral-900">{client.name}</TD>
                  <TD>
                    {client.is_active ? (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Archived
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right font-mono text-xs">
                    {client.projects_count ?? '—'}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            mode: 'edit',
                            id: client.id,
                            name: client.name,
                            contact: '',
                            currency: 'ZAR',
                            submitting: false,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDeleteConfirm({ client, submitting: false })
                        }
                      >
                        Archive
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Create/Edit modal */}
      <Modal
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        {editor ? (
          <ModalContent
            title={editor.mode === 'create' ? 'New client' : 'Edit client'}
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
                  {editor.mode === 'create' ? 'Create client' : 'Save changes'}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Input
                label="Name"
                required
                value={editor.name}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                }
              />
              <Input
                label="Contact (optional)"
                placeholder="e.g. ops@acme.com"
                value={editor.contact}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev ? { ...prev, contact: e.target.value } : prev,
                  )
                }
              />
              <Select
                label="Currency (ISO 4217)"
                value={editor.currency}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev ? { ...prev, currency: e.target.value } : prev,
                  )
                }
                options={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
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

      {/* Archive confirmation */}
      <Modal
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
      >
        {deleteConfirm ? (
          <ModalContent
            title="Archive client?"
            description={`This will archive ${deleteConfirm.client.name}. Projects referencing this client will block the archive.`}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setDeleteConfirm(null)}
                  disabled={deleteConfirm.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={deleteConfirm.submitting}
                  onClick={() => void submitDelete()}
                >
                  Archive client
                </Button>
              </>
            }
          >
            {deleteConfirm.error ? (
              <p role="alert" className="text-xs text-danger-600">
                {deleteConfirm.error}
              </p>
            ) : (
              <p className="text-sm text-neutral-600">
                Archived clients no longer appear in project pickers. You can restore
                them via API.
              </p>
            )}
          </ModalContent>
        ) : null}
      </Modal>
    </div>
  );
}
