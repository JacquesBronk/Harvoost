import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/lib/api-client.js';
import type {
  BillableRate,
  CostRate,
  OffsetPaginated,
} from '../src/lib/api-types.js';

/**
 * INC-004 — Admin › Rates endpoints (Rows 4 & 5).
 *
 * The page calls `/v1/cost-rates` and `/v1/billable-rates`. The backend lane is
 * implementing those controllers to satisfy these exact request shapes and the
 * `OffsetPaginated<T>` ({ data, page, page_size, total_count }) response. These
 * tests pin the GET (current + history) and POST shapes the page issues so the
 * two lanes can cross-check, matching the node-env mocked-fetch convention.
 */

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureFetch(body: unknown): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi
    .fn()
    .mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(jsonResponse(200, body));
    });
  return { calls, restore: () => void (globalThis.fetch = original) };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});
afterEach(() => vi.restoreAllMocks());

describe('cost-rates requests (INC-004 Row 4)', () => {
  it('GET current: ?current=true&page&page_size', async () => {
    const { calls, restore } = captureFetch({
      data: [],
      page: 1,
      page_size: 200,
      total_count: 0,
    });
    try {
      await apiFetch<OffsetPaginated<CostRate>>('/v1/cost-rates', {
        query: { current: true, page: 1, page_size: 200 },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/cost-rates');
    expect(url.searchParams.get('current')).toBe('true');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('page_size')).toBe('200');
  });

  it('GET history: ?user_id=&page&page_size', async () => {
    const { calls, restore } = captureFetch({
      data: [],
      page: 1,
      page_size: 100,
      total_count: 0,
    });
    try {
      await apiFetch<OffsetPaginated<CostRate>>('/v1/cost-rates', {
        query: { user_id: 'usr_7', page: 1, page_size: 100 },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/cost-rates');
    expect(url.searchParams.get('user_id')).toBe('usr_7');
  });

  it('POST: { user_id, rate, currency, effective_from }', async () => {
    const { calls, restore } = captureFetch({});
    try {
      await apiFetch<CostRate>('/v1/cost-rates', {
        method: 'POST',
        body: {
          user_id: 'usr_7',
          rate: 850,
          currency: 'ZAR',
          effective_from: '2026-05-01',
        },
      });
    } finally {
      restore();
    }
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      user_id: 'usr_7',
      rate: 850,
      currency: 'ZAR',
      effective_from: '2026-05-01',
    });
  });

  it('reads the `data` envelope with the contract row fields', async () => {
    const rate: CostRate = {
      id: 'cr_1',
      user_id: 'usr_7',
      rate: 850,
      currency: 'ZAR',
      effective_from: '2026-05-01',
      effective_to: null,
      created_by: 'usr_admin',
      created_at: '2026-05-01T00:00:00.000Z',
    };
    const { restore } = captureFetch({
      data: [rate],
      page: 1,
      page_size: 200,
      total_count: 1,
    });
    try {
      const res = await apiFetch<OffsetPaginated<CostRate>>('/v1/cost-rates', {
        query: { current: true, page: 1, page_size: 200 },
      });
      expect(res.data).toHaveLength(1);
      expect(res.data[0]!.user_id).toBe('usr_7');
      expect(res.data[0]!.rate).toBe(850);
      expect(res.data[0]!.effective_to).toBeNull();
      expect(res.total_count).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('billable-rates requests (INC-004 Row 5)', () => {
  it('GET current: ?current=true&page&page_size', async () => {
    const { calls, restore } = captureFetch({
      data: [],
      page: 1,
      page_size: 200,
      total_count: 0,
    });
    try {
      await apiFetch<OffsetPaginated<BillableRate>>('/v1/billable-rates', {
        query: { current: true, page: 1, page_size: 200 },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/billable-rates');
    expect(url.searchParams.get('current')).toBe('true');
  });

  it('GET history: ?project_id=&page&page_size', async () => {
    const { calls, restore } = captureFetch({
      data: [],
      page: 1,
      page_size: 100,
      total_count: 0,
    });
    try {
      await apiFetch<OffsetPaginated<BillableRate>>('/v1/billable-rates', {
        query: { project_id: 'prj_3', page: 1, page_size: 100 },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('project_id')).toBe('prj_3');
  });

  it('POST: { project_id, task_id?, rate, currency, effective_from }', async () => {
    const { calls, restore } = captureFetch({});
    try {
      await apiFetch<BillableRate>('/v1/billable-rates', {
        method: 'POST',
        body: {
          project_id: 'prj_3',
          rate: 1500,
          currency: 'ZAR',
          effective_from: '2026-05-01',
        },
      });
    } finally {
      restore();
    }
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      project_id: 'prj_3',
      rate: 1500,
      currency: 'ZAR',
      effective_from: '2026-05-01',
    });
  });

  it('reads the `data` envelope and picks the project default (task_id == null)', async () => {
    const defaultRow: BillableRate = {
      id: 'br_1',
      project_id: 'prj_3',
      task_id: null,
      rate: 1500,
      currency: 'ZAR',
      effective_from: '2026-05-01',
      effective_to: null,
      created_by: 'usr_admin',
      created_at: '2026-05-01T00:00:00.000Z',
    };
    const taskRow: BillableRate = {
      ...defaultRow,
      id: 'br_2',
      task_id: 'tsk_9',
      task_name: 'Design',
      rate: 1800,
    };
    const { restore } = captureFetch({
      data: [defaultRow, taskRow],
      page: 1,
      page_size: 200,
      total_count: 2,
    });
    try {
      const res = await apiFetch<OffsetPaginated<BillableRate>>(
        '/v1/billable-rates',
        { query: { current: true, page: 1, page_size: 200 } },
      );
      // The page selects task_id == null as the project default.
      const projectDefault = res.data.find((r) => r.task_id == null);
      expect(projectDefault?.project_id).toBe('prj_3');
      expect(projectDefault?.rate).toBe(1500);
    } finally {
      restore();
    }
  });
});
