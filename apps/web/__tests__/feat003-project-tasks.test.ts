import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminTasksKey,
  buildTaskPatch,
  createProjectTask,
  fetchAdminProjectTasks,
  isTaskNameExistsError,
  pickerTasksKey,
  TASK_NAME_EXISTS,
  updateProjectTask,
} from '../src/lib/project-tasks.js';
import { ApiError } from '../src/lib/api-client.js';
import type { ProjectTask } from '../src/lib/api-types.js';

/**
 * FEAT-003 (GitHub #16) — admin project-task write path.
 *
 * Pins the exact contract the Tasks drawer sends to the API:
 *   - POST  /v1/projects/{id}/tasks          body { name, is_billable }
 *   - PATCH /v1/projects/{id}/tasks/{taskId} body (partial, NEVER empty)
 *   - admin list = GET /v1/projects/{id}/tasks WITHOUT is_active (admins see
 *     archived tasks); the picker key is invalidated alongside the admin key.
 *
 * Also covers the two contract traps:
 *   - buildTaskPatch never produces an empty body (minProperties: 1 → 400),
 *   - ids stay strings (no Number()).
 *
 * Node-env mocked-fetch, mirroring feat001-timer-wiring.test.ts.
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

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('query keys (picker invalidation contract — AC-8)', () => {
  it('admin list key is distinct from the time-entry picker key but shares the project id', () => {
    expect(adminTasksKey('42')).toEqual(['admin', 'projects', '42', 'tasks']);
    // The picker key MUST match NewEntryForm / StartTimerControl exactly.
    expect(pickerTasksKey('42')).toEqual(['projects', '42', 'tasks']);
  });
});

describe('fetchAdminProjectTasks (admin list — no is_active filter)', () => {
  it('hits GET /v1/projects/{id}/tasks with NO is_active query so archived tasks surface', async () => {
    const tasks: ProjectTask[] = [
      { id: '7', project_id: '42', name: 'Dev', is_billable: true, is_active: true },
      { id: '8', project_id: '42', name: 'Old', is_billable: false, is_active: false },
    ];
    const { calls, restore } = captureFetch({ data: tasks });
    try {
      const res = await fetchAdminProjectTasks('42');
      expect(res.data).toHaveLength(2);
      expect(typeof res.data[0]!.id).toBe('string');
      expect(typeof res.data[0]!.project_id).toBe('string');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/projects/42/tasks');
    expect(url.searchParams.has('is_active')).toBe(false);
  });
});

describe('createProjectTask (POST)', () => {
  it('POSTs { name, is_billable } to the per-project tasks path', async () => {
    const created: ProjectTask = {
      id: '9',
      project_id: '42',
      name: 'Research',
      is_billable: true,
      is_active: true,
    };
    const { calls, restore } = captureFetch(created, 201);
    try {
      const res = await createProjectTask('42', { name: 'Research', is_billable: true });
      expect(res.id).toBe('9');
    } finally {
      restore();
    }
    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/projects/42/tasks');
    expect(call.init?.method).toBe('POST');
    expect(bodyOf(call.init)).toEqual({ name: 'Research', is_billable: true });
  });

  it('carries is_billable: false through when the toggle is non-billable', async () => {
    const { calls, restore } = captureFetch(
      { id: '9', project_id: '42', name: 'Admin', is_billable: false, is_active: true },
      201,
    );
    try {
      await createProjectTask('42', { name: 'Admin', is_billable: false });
    } finally {
      restore();
    }
    expect(bodyOf(calls[0]!.init)).toEqual({ name: 'Admin', is_billable: false });
  });
});

describe('updateProjectTask (PATCH)', () => {
  it('PATCHes the task path with only the supplied fields', async () => {
    const { calls, restore } = captureFetch({
      id: '7',
      project_id: '42',
      name: 'Dev (renamed)',
      is_billable: true,
      is_active: true,
    });
    try {
      await updateProjectTask('42', '7', { name: 'Dev (renamed)' });
    } finally {
      restore();
    }
    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/projects/42/tasks/7');
    expect(call.init?.method).toBe('PATCH');
    expect(bodyOf(call.init)).toEqual({ name: 'Dev (renamed)' });
  });

  it('archives via { is_active: false } and reactivates via { is_active: true }', async () => {
    const archived = captureFetch({
      id: '7',
      project_id: '42',
      name: 'Dev',
      is_billable: true,
      is_active: false,
    });
    try {
      await updateProjectTask('42', '7', { is_active: false });
    } finally {
      archived.restore();
    }
    expect(bodyOf(archived.calls[0]!.init)).toEqual({ is_active: false });

    const reactivated = captureFetch({
      id: '7',
      project_id: '42',
      name: 'Dev',
      is_billable: true,
      is_active: true,
    });
    try {
      await updateProjectTask('42', '7', { is_active: true });
    } finally {
      reactivated.restore();
    }
    expect(bodyOf(reactivated.calls[0]!.init)).toEqual({ is_active: true });
  });

  it('surfaces the REAL duplicate-active-name envelope (400 VALIDATION_FAILED + details.code)', async () => {
    // The backend maps the Postgres 23505 via ValidationFailedError following the
    // clients/billable-rates precedent: HTTP 400, TOP-LEVEL code VALIDATION_FAILED,
    // and the stable TASK_NAME_EXISTS code NESTED at details.code. The client's
    // ApiError preserves status/code/details verbatim, so the thrown error must
    // expose exactly that shape (this is what the drawer's mapping narrows on).
    const { restore } = captureFetch(
      {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: { code: TASK_NAME_EXISTS },
      },
      400,
    );
    try {
      await expect(updateProjectTask('42', '7', { name: 'Dev' })).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        details: { code: TASK_NAME_EXISTS },
      });
    } finally {
      restore();
    }
  });
});

describe('buildTaskPatch (never emits an empty body — minProperties: 1)', () => {
  const current = { name: 'Dev', is_billable: true };

  it('returns null when nothing changed (caller skips the PATCH → no 400)', () => {
    expect(buildTaskPatch(current, { name: 'Dev', isBillable: true })).toBeNull();
    // Whitespace-only difference is also a no-op after trimming.
    expect(buildTaskPatch(current, { name: '  Dev  ', isBillable: true })).toBeNull();
  });

  it('includes only the changed name (trimmed)', () => {
    expect(buildTaskPatch(current, { name: '  Renamed ', isBillable: true })).toEqual({
      name: 'Renamed',
    });
  });

  it('includes only the changed billability', () => {
    expect(buildTaskPatch(current, { name: 'Dev', isBillable: false })).toEqual({
      is_billable: false,
    });
  });

  it('includes both when both changed', () => {
    expect(buildTaskPatch(current, { name: 'New', isBillable: false })).toEqual({
      name: 'New',
      is_billable: false,
    });
  });

  it('ignores an empty new name (treated as no-op, never sent)', () => {
    expect(buildTaskPatch(current, { name: '   ', isBillable: true })).toBeNull();
  });
});

describe('isTaskNameExistsError (drawer duplicate-name detection — AC-6 seam)', () => {
  // The friendly sentence the drawer surfaces. We replicate the drawer's
  // describeTaskError mapping here (it is a local closure in page.tsx that
  // delegates to isTaskNameExistsError) so the assertion pins the user-visible
  // outcome, not just the predicate.
  const FRIENDLY = 'A task with that name already exists in this project.';
  const describeTaskError = (err: unknown): string =>
    isTaskNameExistsError(err) ? FRIENDLY : 'generic';

  it('detects the REAL envelope: 400 VALIDATION_FAILED with details.code === TASK_NAME_EXISTS', () => {
    // This is the shape AC-6 actually returns. Before the fix the drawer matched
    // only top-level code / 422 / 409, so this path fell through to a generic
    // error — a green test against a fictional envelope is what let it through.
    const err = new ApiError(400, {
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      details: { code: TASK_NAME_EXISTS },
    });
    expect(isTaskNameExistsError(err)).toBe(true);
    expect(describeTaskError(err)).toBe(FRIENDLY);
  });

  it('still detects the forward-compat top-level code shape', () => {
    const err = new ApiError(400, { code: TASK_NAME_EXISTS, message: 'dup' });
    expect(isTaskNameExistsError(err)).toBe(true);
    expect(describeTaskError(err)).toBe(FRIENDLY);
  });

  it('still detects the forward-compat 422 / 409 status shapes', () => {
    expect(
      isTaskNameExistsError(new ApiError(422, { code: 'VALIDATION_FAILED', message: 'x' })),
    ).toBe(true);
    expect(
      isTaskNameExistsError(new ApiError(409, { code: 'CONFLICT', message: 'x' })),
    ).toBe(true);
  });

  it('does NOT misfire on unrelated 400s, other detail codes, or non-ApiError', () => {
    // A generic 400 with no matching code/details must fall through.
    expect(
      isTaskNameExistsError(
        new ApiError(400, {
          code: 'VALIDATION_FAILED',
          message: 'x',
          details: { code: 'SOME_OTHER_CODE' },
        }),
      ),
    ).toBe(false);
    // Missing / malformed details must be narrowed safely (no throw).
    expect(
      isTaskNameExistsError(new ApiError(400, { code: 'VALIDATION_FAILED', message: 'x' })),
    ).toBe(false);
    expect(isTaskNameExistsError(new Error('plain'))).toBe(false);
    expect(isTaskNameExistsError(undefined)).toBe(false);
  });
});
