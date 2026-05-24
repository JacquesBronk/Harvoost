import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManualEntry,
  fetchProjectTasks,
  fetchProjectsForPicker,
  fetchRunning,
  startTimer,
  switchTimer,
  validateManualEntry,
} from '../src/lib/time-entries.js';
import type { ProjectTask, TimeEntry } from '../src/lib/api-types.js';

/**
 * FEAT-001 (GitHub #5) — start-timer / switch / manual-create wiring.
 *
 * Pins the exact contract each shared lib fn sends to the LIVE controller, where
 * it diverges from openapi.yaml (these are real traps):
 *   - switch sends `project_id` (NOT the spec's `new_project_id`),
 *   - manual create attaches NO Idempotency-Key (the route does not read one),
 *   - start/switch attach exactly one fresh Idempotency-Key per submit,
 *   - running consumes the `{ data }` envelope (a started timer surfaces),
 *   - the task picker fetches GET /v1/projects/{id}/tasks and is optional,
 *   - client validation blocks end ≤ start before any API call.
 *
 * Node-env mocked-fetch, mirroring apps/web/__tests__/inc004-reports-query.test.ts.
 */

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Capture URL + init (method/headers/body) of every apiFetch call. */
function captureFetch(body: unknown, status = 200): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi
    .fn()
    .mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(jsonResponse(status, body));
    });
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return null;
  const found = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return found ? (found[1] as string) : null;
}

const SAMPLE_ENTRY: TimeEntry = {
  id: '101',
  user_id: '1',
  project_id: '42',
  start_at: '2026-05-23T09:00:00.000+00:00',
  status: 'running',
  billable: true,
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});
afterEach(() => vi.restoreAllMocks());

describe('startTimer (POST /v1/time-entries/start)', () => {
  it('POSTs to /start with project_id + exactly one Idempotency-Key', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY, 201);
    try {
      await startTimer({ project_id: '42' });
    } finally {
      restore();
    }
    const { url, init } = calls[0]!;
    expect(new URL(url).pathname).toBe('/v1/time-entries/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ project_id: '42' });

    // Exactly one Idempotency-Key, and it is a non-empty UUID-shaped string.
    const key = headerValue(init, 'Idempotency-Key');
    expect(key).toBeTruthy();
    expect(key).toMatch(/[0-9a-f-]{8,}/i);
  });

  it('includes task_id + notes only when provided (no empty fields)', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY, 201);
    try {
      await startTimer({ project_id: '42', task_id: '7', notes: 'spike' });
    } finally {
      restore();
    }
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      project_id: '42',
      task_id: '7',
      notes: 'spike',
    });
  });

  it('returns the entry UNWRAPPED (no { data } envelope)', async () => {
    const { restore } = captureFetch(SAMPLE_ENTRY, 201);
    try {
      const entry = await startTimer({ project_id: '42' });
      expect(entry.id).toBe('101');
      expect((entry as unknown as { data?: unknown }).data).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('switchTimer (POST /v1/time-entries/switch)', () => {
  it('sends body field `project_id` — NOT the spec `new_project_id`', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY);
    try {
      await switchTimer({ project_id: '99' });
    } finally {
      restore();
    }
    const { url, init } = calls[0]!;
    expect(new URL(url).pathname).toBe('/v1/time-entries/switch');
    expect(init?.method).toBe('POST');
    const parsed = JSON.parse(String(init?.body));
    expect(parsed).toEqual({ project_id: '99' });
    expect(parsed.new_project_id).toBeUndefined();
    expect(headerValue(init, 'Idempotency-Key')).toBeTruthy();
  });

  it('uses a FRESH Idempotency-Key per submit', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY);
    try {
      await switchTimer({ project_id: '99' });
      await switchTimer({ project_id: '99' });
    } finally {
      restore();
    }
    const k1 = headerValue(calls[0]!.init, 'Idempotency-Key');
    const k2 = headerValue(calls[1]!.init, 'Idempotency-Key');
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });
});

describe('createManualEntry (POST /v1/time-entries)', () => {
  it('POSTs project_id/start_at/end_at and attaches NO Idempotency-Key', async () => {
    const { calls, restore } = captureFetch({ ...SAMPLE_ENTRY, status: 'draft' }, 201);
    try {
      await createManualEntry({
        project_id: '42',
        start_at: '2026-05-23T09:00:00.000+02:00',
        end_at: '2026-05-23T11:30:00.000+02:00',
        notes: 'planning',
      });
    } finally {
      restore();
    }
    const { url, init } = calls[0]!;
    expect(new URL(url).pathname).toBe('/v1/time-entries');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      project_id: '42',
      start_at: '2026-05-23T09:00:00.000+02:00',
      end_at: '2026-05-23T11:30:00.000+02:00',
      notes: 'planning',
    });
    // The manual-create route does not read this header — must NOT be attached.
    expect(headerValue(init, 'Idempotency-Key')).toBeNull();
  });

  it('omits empty task_id / notes', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY, 201);
    try {
      await createManualEntry({
        project_id: '42',
        start_at: '2026-05-23T09:00:00.000+02:00',
        end_at: '2026-05-23T10:00:00.000+02:00',
      });
    } finally {
      restore();
    }
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      project_id: '42',
      start_at: '2026-05-23T09:00:00.000+02:00',
      end_at: '2026-05-23T10:00:00.000+02:00',
    });
  });
});

describe('fetchProjectTasks (GET /v1/projects/{id}/tasks)', () => {
  it('hits the per-project tasks path with is_active=true and returns data[]', async () => {
    const tasks: ProjectTask[] = [
      { id: '7', project_id: '42', name: 'Design', is_billable: true, is_active: true },
      { id: '8', project_id: '42', name: 'QA', is_billable: false, is_active: true },
    ];
    const { calls, restore } = captureFetch({ data: tasks });
    try {
      const res = await fetchProjectTasks('42');
      expect(res.data).toHaveLength(2);
      expect(res.data[0]!.id).toBe('7');
      // ids are STRINGS (INC-004 BigInt fix).
      expect(typeof res.data[0]!.id).toBe('string');
      expect(typeof res.data[0]!.project_id).toBe('string');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/projects/42/tasks');
    expect(url.searchParams.get('is_active')).toBe('true');
  });

  it('tolerates an empty task list (optional picker — proceeding is allowed)', async () => {
    const { restore } = captureFetch({ data: [] });
    try {
      const res = await fetchProjectTasks('42');
      expect(res.data).toEqual([]);
    } finally {
      restore();
    }
    // start with NO task still produces a project-only body — proven above.
  });
});

describe('fetchProjectsForPicker (GET /v1/projects)', () => {
  it('reads the { data } offset envelope (string ids)', async () => {
    const { calls, restore } = captureFetch({
      data: [{ id: '42', name: 'Acme Website' }],
      page: 1,
      page_size: 100,
    });
    try {
      const res = await fetchProjectsForPicker();
      expect(res.data[0]!.id).toBe('42');
      expect(res.data[0]!.name).toBe('Acme Website');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/projects');
    expect(url.searchParams.get('is_active')).toBe('true');
  });
});

describe('fetchRunning (GET /v1/time-entries/running)', () => {
  it('consumes the { data } envelope so a started timer surfaces', async () => {
    const { calls, restore } = captureFetch({ data: SAMPLE_ENTRY });
    try {
      const snapshot = await fetchRunning();
      // A started timer is read from `data.data`, not the old `.running`.
      expect(snapshot.data).not.toBeNull();
      expect(snapshot.data!.id).toBe('101');
      expect(snapshot.data!.project_id).toBe('42');
      expect((snapshot as unknown as { running?: unknown }).running).toBeUndefined();
    } finally {
      restore();
    }
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/time-entries/running');
  });

  it('reads { data: null } as no running timer', async () => {
    const { restore } = captureFetch({ data: null });
    try {
      const snapshot = await fetchRunning();
      expect(snapshot.data).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('validateManualEntry (client-side, before any API call)', () => {
  it('blocks when end is before start', () => {
    const res = validateManualEntry(
      '2026-05-23T11:00:00.000+02:00',
      '2026-05-23T09:00:00.000+02:00',
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('End must be after start');
  });

  it('blocks when end equals start', () => {
    const res = validateManualEntry(
      '2026-05-23T09:00:00.000+02:00',
      '2026-05-23T09:00:00.000+02:00',
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('End must be after start');
  });

  it('blocks when duration exceeds 24h', () => {
    const res = validateManualEntry(
      '2026-05-23T09:00:00.000+02:00',
      '2026-05-24T10:00:00.000+02:00',
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/24 hours/);
  });

  it('allows a valid range (end > start, ≤ 24h)', () => {
    const res = validateManualEntry(
      '2026-05-23T09:00:00.000+02:00',
      '2026-05-23T11:30:00.000+02:00',
    );
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('allows future-dated AND back-dated ranges (no date floor/ceiling)', () => {
    // Future-dated.
    expect(
      validateManualEntry(
        '2099-01-01T09:00:00.000+02:00',
        '2099-01-01T10:00:00.000+02:00',
      ).ok,
    ).toBe(true);
    // Back-dated.
    expect(
      validateManualEntry(
        '2000-01-01T09:00:00.000+02:00',
        '2000-01-01T10:00:00.000+02:00',
      ).ok,
    ).toBe(true);
  });

  it('does not call the API when validation blocks (guards createManualEntry)', async () => {
    const { calls, restore } = captureFetch(SAMPLE_ENTRY, 201);
    try {
      const check = validateManualEntry(
        '2026-05-23T11:00:00.000+02:00',
        '2026-05-23T09:00:00.000+02:00',
      );
      // The component only calls createManualEntry when check.ok — emulate that gate.
      if (check.ok) {
        await createManualEntry({
          project_id: '42',
          start_at: '2026-05-23T11:00:00.000+02:00',
          end_at: '2026-05-23T09:00:00.000+02:00',
        });
      }
      expect(check.ok).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
