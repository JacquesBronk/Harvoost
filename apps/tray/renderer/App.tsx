import { useEffect, useState } from 'react';
import { Button, LoadingSpinner } from '@harvoost/ui';
import { LogIn, Timer } from 'lucide-react';
import { ipcClient } from './lib/ipc-client.js';
import { MorningPrompt } from './components/MorningPrompt.js';
import { ActiveTimer } from './components/ActiveTimer.js';
import { SyncStatus } from './components/SyncStatus.js';

interface RunningSnapshot {
  running: {
    id: string;
    project_id: string;
    project_name?: string;
    task_name?: string | null;
    start_at: string;
  } | null;
  clocked_in_today: boolean;
  today_total_hours: number;
}

type AppState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'morning'; snapshot: RunningSnapshot }
  | { kind: 'running'; snapshot: RunningSnapshot }
  | { kind: 'idle'; snapshot: RunningSnapshot };

export function App() {
  const [state, setState] = useState<AppState>({ kind: 'loading' });
  const [connected, setConnected] = useState(false);

  async function refresh() {
    const res = await ipcClient.apiRequest<RunningSnapshot>('/v1/sync/snapshot');
    if (!res.ok) {
      if (res.status === 401) {
        setState({ kind: 'signed-out' });
        return;
      }
      // Network errors / not yet signed in.
      setState({ kind: 'signed-out' });
      return;
    }
    const snap = res.data!;
    if (snap.running) {
      setState({ kind: 'running', snapshot: snap });
    } else if (!snap.clocked_in_today) {
      setState({ kind: 'morning', snapshot: snap });
    } else {
      setState({ kind: 'idle', snapshot: snap });
    }
  }

  useEffect(() => {
    void refresh();
    const offConn = ipcClient.onConnectionChange(setConnected);
    const offAuthExpired = ipcClient.onAuthExpired(() => {
      // Bearer rejected by the API — drop to signed-out so the user can
      // re-authenticate. The SSE consumer in main/sync.ts already stops
      // reconnecting until a fresh token is supplied.
      setState({ kind: 'signed-out' });
      setConnected(false);
    });
    const offEvt = ipcClient.onSyncEvent((event) => {
      // The backend SSE service emits `timer.started`, `timer.stopped`,
      // `timer.switched`, `entry.submitted`, and `entry.approved`. We also
      // accept the legacy `time_entry.*` aliases for forward-compatibility
      // with any earlier backend builds. On any event the simplest correct
      // behaviour is to refetch the running-timer snapshot — the snapshot
      // endpoint is cheap (one row) and trivially idempotent.
      const refreshing = new Set([
        'timer.started',
        'timer.stopped',
        'timer.switched',
        'entry.submitted',
        'entry.approved',
        // Legacy aliases — safe to remove once the backend SSE service is
        // confirmed to only emit the canonical names above.
        'time_entry.started',
        'time_entry.stopped',
        'time_entry.updated',
      ]);
      if (refreshing.has(event.event)) {
        void refresh();
      }
    });
    return () => {
      offConn();
      offEvt();
      offAuthExpired();
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="md" label="Loading Harvoost" />
      </div>
    );
  }

  if (state.kind === 'signed-out') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Timer className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">Welcome to Harvoost</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Sign in with your work account to start tracking time from your menu bar.
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          iconLeft={<LogIn className="h-4 w-4" aria-hidden="true" />}
          onClick={() => ipcClient.signIn()}
        >
          Sign in with Microsoft
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-white">
            <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          Harvoost
        </div>
        <SyncStatus connected={connected} />
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {state.kind === 'running' && state.snapshot.running ? (
          <ActiveTimer timer={state.snapshot.running} onStopped={refresh} />
        ) : state.kind === 'morning' ? (
          <MorningPrompt onStarted={refresh} />
        ) : (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
            You&apos;re clocked out for now. Open the web app to start a new entry, or
            wait for tomorrow&apos;s morning prompt.
          </div>
        )}
      </div>

      <footer className="border-t border-neutral-100 px-4 py-2 text-xs text-neutral-500">
        Today: {state.snapshot.today_total_hours.toFixed(1)}h logged
      </footer>
    </div>
  );
}
