import { useState } from 'react';
import { Button, MoodPicker } from '@harvoost/ui';
import { ipcClient } from '../lib/ipc-client.js';

interface MorningPromptProps {
  defaultProjectId?: string;
  onStarted(): void;
}

// F1.1: Ready to start your day? Renders mood picker + Yes/No buttons.
// "Yes" is disabled until a mood is selected (mood is required at clock-in).

export function MorningPrompt({ defaultProjectId, onStarted }: MorningPromptProps) {
  const [mood, setMood] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-center text-sm text-neutral-600">
        No problem. We won&apos;t ask again today.
      </div>
    );
  }

  async function handleYes() {
    if (!mood) return;
    setStarting(true);
    setError(null);
    const result = await ipcClient.apiRequest('/v1/time-entries/start', {
      method: 'POST',
      idempotent: true,
      body: {
        project_id: defaultProjectId,
        mood_score: mood,
        source: 'tray_morning_prompt',
      },
    });
    setStarting(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'Could not start the timer.');
      return;
    }
    onStarted();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">Ready to start your day?</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Pick how you&apos;re feeling before clocking in.
        </p>
      </div>

      <MoodPicker value={mood} onChange={setMood} size="lg" />

      {error ? (
        <p role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={() => setDismissed(true)}>
          Not yet
        </Button>
        <Button variant="primary" size="md" disabled={!mood} loading={starting} onClick={handleYes}>
          Yes, start my day
        </Button>
      </div>
    </div>
  );
}
