'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, LoadingSpinner, useToast } from '@harvoost/ui';
import { apiFetch, describeError, newIdempotencyKey } from '@/lib/api-client.js';
import type { RunningTimerSnapshot } from '@/lib/api-types.js';
import { fetchRunning } from '@/lib/time-entries.js';
import { StartTimerControl } from '@/components/StartTimerControl.js';

// Polls the API for the canonical running-timer state. In production we'd
// subscribe to /v1/sync/stream (SSE) for sub-second updates; v1 falls back
// to a 10s poll which still meets the p95<5s end-to-end target for the
// tray→web demo path because the tray pushes to the API which acks before
// we poll again.
//
// TODO(build-phase-followup): switch to EventSource on /v1/sync/stream
// once the backend SSE endpoint stabilises.

export function TimerBar() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [startOpen, setStartOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

  const { data, isLoading } = useQuery<RunningTimerSnapshot>({
    queryKey: ['time-entries', 'running'],
    queryFn: fetchRunning,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  // FEAT-001: GET /v1/time-entries/running returns the `{ data }` envelope; the
  // running entry (or null) is `data.data`. The old `.running` read always
  // resolved to undefined against the live backend, so a started timer never
  // surfaced in this bar.
  const running = data?.data ?? null;

  // Tick the local elapsed counter from the canonical server start_at.
  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }
    function tick() {
      const startMs = running ? new Date(running.start_at).getTime() : Date.now();
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  // Collapse the switch panel once a switch lands (running entry changes).
  useEffect(() => {
    setSwitchOpen(false);
  }, [running?.id, running?.project_id]);

  const stopMutation = useMutation({
    mutationFn: () =>
      apiFetch('/v1/time-entries/stop', {
        method: 'POST',
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      }),
    onSuccess: () => {
      toast.success('Timer stopped');
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
    },
    onError: (err) => toast.error('Could not stop timer', describeError(err)),
  });

  if (isLoading) {
    return (
      <div className="border-b border-neutral-200 bg-white px-4 py-2 lg:px-8">
        <LoadingSpinner size="sm" label="Loading timer" />
      </div>
    );
  }

  if (!running) {
    return (
      <div className="border-b border-neutral-200 bg-white px-4 py-2 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            No active timer
          </div>
          <Button
            size="sm"
            variant="primary"
            iconLeft={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
            aria-expanded={startOpen}
            aria-controls="timerbar-start-panel"
            onClick={() => setStartOpen((v) => !v)}
          >
            Start timer
          </Button>
        </div>
        {startOpen ? (
          <div
            id="timerbar-start-panel"
            className="mt-2 rounded-md border border-neutral-200 bg-neutral-50/60 p-3"
          >
            <StartTimerControl
              mode="start"
              layout="compact"
              onDone={() => setStartOpen(false)}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-b border-neutral-200 bg-brand-50/60 px-4 py-2 lg:px-8">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="brand" dot>
            Running
          </Badge>
          <span className="truncate text-sm font-medium text-neutral-900">
            {running.project_name ?? `Project #${running.project_id}`}
            {running.task_name ? ` · ${running.task_name}` : ''}
          </span>
          <span className="font-mono text-xs text-neutral-600" aria-label="elapsed time">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />}
            aria-expanded={switchOpen}
            aria-controls="timerbar-switch-panel"
            onClick={() => setSwitchOpen((v) => !v)}
          >
            Switch
          </Button>
          <Button
            size="sm"
            variant="primary"
            iconLeft={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
            loading={stopMutation.isPending}
            onClick={() => stopMutation.mutate()}
          >
            Stop
          </Button>
        </div>
      </div>
      {switchOpen ? (
        <div
          id="timerbar-switch-panel"
          className="mt-2 rounded-md border border-neutral-200 bg-white p-3"
        >
          <StartTimerControl
            mode="switch"
            layout="compact"
            onDone={() => setSwitchOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
