import { useEffect, useState } from 'react';
import { Button } from '@harvoost/ui';
import { Square } from 'lucide-react';
import { ipcClient } from '../lib/ipc-client.js';

interface RunningTimer {
  id: string;
  project_id: string;
  project_name?: string;
  task_name?: string | null;
  start_at: string;
}

interface Props {
  timer: RunningTimer;
  onStopped(): void;
}

export function ActiveTimer({ timer, onStopped }: Props) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function tick() {
      const startMs = new Date(timer.start_at).getTime();
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timer.start_at]);

  async function handleStop() {
    setStopping(true);
    setError(null);
    const result = await ipcClient.apiRequest('/v1/time-entries/stop', {
      method: 'POST',
      idempotent: true,
    });
    setStopping(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'Could not stop the timer.');
      return;
    }
    onStopped();
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-brand-700">Running</div>
        <div className="mt-1 text-lg font-semibold text-neutral-900">
          {timer.project_name ?? `Project #${timer.project_id}`}
        </div>
        {timer.task_name ? (
          <div className="text-xs text-neutral-500">{timer.task_name}</div>
        ) : null}
      </div>
      <div className="font-mono text-3xl tabular-nums text-neutral-900" aria-live="polite">
        {formatElapsed(elapsedSeconds)}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="danger"
          size="md"
          loading={stopping}
          iconLeft={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
          onClick={handleStop}
        >
          Stop
        </Button>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
