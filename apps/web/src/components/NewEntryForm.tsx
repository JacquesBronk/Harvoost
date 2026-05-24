'use client';

// FEAT-001 (GitHub #5) — manual "New entry" modal.
//
// Project (required) + task (optional) + start/end datetime (required) + notes.
// Client validation (end > start, ≤ 24h) runs BEFORE any API call. Back-dating
// AND future-dating are allowed (gate (a) decision #3 — no date floor/ceiling).
// Submit → POST /v1/time-entries (NO Idempotency-Key) → the draft entry appears
// in the week list.

import { Button, Input, Modal, ModalContent, Select, useToast } from '@harvoost/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useId, useState } from 'react';
import { describeError } from '@/lib/api-client.js';
import {
  createManualEntry,
  fetchProjectTasks,
  fetchProjectsForPicker,
  validateManualEntry,
} from '@/lib/time-entries.js';

const NOTES_MAX = 2000;

export interface NewEntryFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewer time zone — datetime-local values are interpreted in this zone. */
  zone: string;
}

/**
 * Convert a `datetime-local` value (e.g. "2026-05-23T09:00", zoneless) to a full
 * ISO-8601 string WITH the viewer's offset, the wire format the API expects.
 */
function localInputToIso(local: string, zone: string): string {
  if (!local) return '';
  const dt = DateTime.fromISO(local, { zone });
  return dt.isValid ? (dt.toISO() ?? '') : '';
}

function durationLabel(start: string, end: string, zone: string): string | null {
  const s = localInputToIso(start, zone);
  const e = localInputToIso(end, zone);
  if (!s || !e) return null;
  const hours = (Date.parse(e) - Date.parse(s)) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return `${hours.toFixed(1)}h`;
}

export function NewEntryForm({ open, onOpenChange, zone }: NewEntryFormProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const notesId = useId();

  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | undefined>();

  // Reset every field whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setProjectId('');
      setTaskId('');
      setStart('');
      setEnd('');
      setNotes('');
      setError(undefined);
    }
  }, [open]);

  useEffect(() => {
    setTaskId('');
  }, [projectId]);

  const projectsQuery = useQuery({
    enabled: open,
    queryKey: ['projects', 'picker'],
    queryFn: fetchProjectsForPicker,
  });

  const tasksQuery = useQuery({
    enabled: open && !!projectId,
    queryKey: ['projects', projectId, 'tasks'],
    queryFn: () => fetchProjectTasks(projectId),
  });

  const projects = projectsQuery.data?.data ?? [];
  const tasks = tasksQuery.data?.data ?? [];

  const mutation = useMutation({
    mutationFn: () =>
      createManualEntry({
        project_id: projectId,
        task_id: taskId || undefined,
        start_at: localInputToIso(start, zone),
        end_at: localInputToIso(end, zone),
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Entry added', 'Your time entry is now a draft in this week.');
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      onOpenChange(false);
    },
    // 409 (overlap) / 422 (validation): surface the server message, keep the
    // form open so the user can adjust.
    onError: (err) => {
      const message = describeError(err);
      setError(message);
      toast.error('Could not add entry', message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setError('Project is required.');
      return;
    }
    const startIso = localInputToIso(start, zone);
    const endIso = localInputToIso(end, zone);
    const check = validateManualEntry(startIso, endIso);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(undefined);
    mutation.mutate();
  }

  const duration = durationLabel(start, end, zone);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ModalContent
          title="New time entry"
          description={`Times are interpreted in ${zone}.`}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="new-entry-form"
                variant="primary"
                size="sm"
                loading={mutation.isPending}
              >
                Save entry
              </Button>
            </>
          }
        >
          <form id="new-entry-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Select
              label="Project"
              placeholder={projectsQuery.isLoading ? 'Loading projects…' : 'Select a project'}
              value={projectId}
              disabled={projectsQuery.isLoading}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(e) => setProjectId(e.target.value)}
            />

            <Select
              label="Task (optional)"
              placeholder={
                !projectId
                  ? 'Pick a project first'
                  : tasksQuery.isLoading
                    ? 'Loading tasks…'
                    : tasks.length === 0
                      ? 'No tasks'
                      : 'No task'
              }
              value={taskId}
              disabled={!projectId || tasksQuery.isLoading || tasks.length === 0}
              options={tasks.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(e) => setTaskId(e.target.value)}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                type="datetime-local"
                label="Start"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
              <Input
                type="datetime-local"
                label="End"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={notesId} className="text-xs font-medium text-neutral-700">
                Notes (optional)
              </label>
              <textarea
                id={notesId}
                value={notes}
                rows={2}
                maxLength={NOTES_MAX}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What did you work on?"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-500">
                {duration ? `Duration: ${duration}` : 'Pick a start and end time.'}
              </span>
              {error ? (
                <span role="alert" className="text-xs font-medium text-danger-600">
                  {error}
                </span>
              ) : null}
            </div>
          </form>
        </ModalContent>
      ) : null}
    </Modal>
  );
}
