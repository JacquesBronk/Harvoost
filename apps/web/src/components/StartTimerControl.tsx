'use client';

// FEAT-001 (GitHub #5) — shared start / switch control.
//
// Renders a project picker (required) + task picker (OPTIONAL) + notes textarea,
// and either STARTS a new timer or SWITCHES the running one (same picker, two
// modes). Used inline on /timesheets AND inside the idle TimerBar AND on the
// running TimerBar's "Switch" affordance — all three call the shared lib in
// time-entries.ts so "both placements" is one code path.

import { Button, LoadingSpinner, Select, useToast } from '@harvoost/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { describeError } from '@/lib/api-client.js';
import {
  fetchProjectTasks,
  fetchProjectsForPicker,
  startTimer,
  switchTimer,
} from '@/lib/time-entries.js';

const NOTES_MAX = 2000;

export interface StartTimerControlProps {
  /** 'start' fires POST /start; 'switch' fires POST /switch (running re-point). */
  mode?: 'start' | 'switch';
  /** Compact layout for the TimerBar dropdown vs. the roomier inline card. */
  layout?: 'inline' | 'compact';
  /** Called after a successful start/switch (e.g. to close a popover). */
  onDone?: () => void;
}

export function StartTimerControl({
  mode = 'start',
  layout = 'inline',
  onDone,
}: StartTimerControlProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const notesId = useId();

  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [notes, setNotes] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();

  const projectsQuery = useQuery({
    queryKey: ['projects', 'picker'],
    queryFn: fetchProjectsForPicker,
  });

  // Tasks are OPTIONAL: only fetched once a project is chosen; an empty list is
  // a valid "No tasks" state, never a blocker.
  const tasksQuery = useQuery({
    enabled: !!projectId,
    queryKey: ['projects', projectId, 'tasks'],
    queryFn: () => fetchProjectTasks(projectId),
  });

  // Reset the task selection whenever the project changes — a task only belongs
  // to its own project.
  useEffect(() => {
    setTaskId('');
  }, [projectId]);

  const projects = projectsQuery.data?.data ?? [];
  const tasks = tasksQuery.data?.data ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        project_id: projectId,
        ...(taskId ? { task_id: taskId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      return mode === 'switch' ? switchTimer(payload) : startTimer(payload);
    },
    onSuccess: () => {
      toast.success(mode === 'switch' ? 'Switched project' : 'Timer started');
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      setProjectId('');
      setTaskId('');
      setNotes('');
      setFieldError(undefined);
      onDone?.();
    },
    onError: (err) =>
      toast.error(
        mode === 'switch' ? 'Could not switch project' : 'Could not start timer',
        describeError(err),
      ),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setFieldError('Pick a project to continue.');
      return;
    }
    setFieldError(undefined);
    mutation.mutate();
  }

  if (projectsQuery.isLoading) {
    return <LoadingSpinner size="sm" label="Loading projects" />;
  }

  if (projectsQuery.isError) {
    return (
      <div className="flex items-center gap-2 text-xs text-danger-600" role="alert">
        <span>{describeError(projectsQuery.error)}</span>
        <Button size="sm" variant="ghost" onClick={() => projectsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        No active projects are assigned to you yet.
      </p>
    );
  }

  const submitLabel = mode === 'switch' ? 'Switch' : 'Start';
  const SubmitIcon = mode === 'switch' ? ArrowLeftRight : Play;

  return (
    <form
      onSubmit={handleSubmit}
      className={
        layout === 'compact'
          ? 'flex flex-col gap-2'
          : 'flex flex-col gap-3 sm:flex-row sm:items-end'
      }
    >
      <div className={layout === 'compact' ? '' : 'sm:w-56'}>
        <Select
          label={mode === 'switch' ? 'Switch to' : 'Project'}
          aria-label={mode === 'switch' ? 'Switch to project' : 'Project'}
          placeholder="Select a project"
          value={projectId}
          error={fieldError}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(e) => setProjectId(e.target.value)}
        />
      </div>

      <div className={layout === 'compact' ? '' : 'sm:w-56'}>
        <Select
          label="Task (optional)"
          aria-label="Task (optional)"
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
      </div>

      <div className={layout === 'compact' ? '' : 'sm:flex-1'}>
        <label htmlFor={notesId} className="text-xs font-medium text-neutral-700">
          Notes (optional)
        </label>
        <textarea
          id={notesId}
          value={notes}
          maxLength={NOTES_MAX}
          rows={layout === 'compact' ? 2 : 1}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What are you working on?"
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </div>

      <Button
        type="submit"
        variant="primary"
        size={layout === 'compact' ? 'sm' : 'md'}
        loading={mutation.isPending}
        iconLeft={<SubmitIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        className={layout === 'compact' ? 'self-start' : ''}
      >
        {submitLabel}
      </Button>
    </form>
  );
}
