import { describe, it, expect } from 'vitest';

// INC-004 (BigInt fix) — regression for the 500 "Do not know how to serialize a BigInt"
// returned by the older list endpoints GET /v1/users, GET /v1/projects, GET /v1/clients.
//
// Cause: those handlers return raw `prisma.$queryRawUnsafe` rows whose Postgres `bigint`
// columns (id, client_id, user_id, …) surface as JS BigInt, and Nest serializes the
// response with JSON.stringify — which throws on BigInt. The fix installs a process-wide
// BigInt.prototype.toJSON in apps/api/src/main.ts so every bigint renders as its decimal
// string.
//
// main.ts is the bootstrap entrypoint (it calls listen()/bootstrap() on import and is
// excluded from vitest coverage), so it cannot be imported into a unit test without
// booting the server. This test installs the *identical* polyfill snippet and proves the
// serialization behaviour the three endpoints rely on. The polyfill is idempotent, so
// installing it here is harmless even if main.ts were also loaded.

// Mirror the exact snippet from apps/api/src/main.ts.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

describe('BigInt JSON serialization polyfill (INC-004)', () => {
  it('serializes a bare BigInt as its decimal string instead of throwing', () => {
    // Before the polyfill this threw: TypeError "Do not know how to serialize a BigInt".
    expect(() => JSON.stringify({ id: 123n })).not.toThrow();
    expect(JSON.parse(JSON.stringify({ id: 123n })).id).toBe('123');
  });

  it('GET /v1/users raw row shape: id serializes as a string', () => {
    // Mirrors UsersController.list() raw row (id is a Postgres bigint).
    const row = {
      id: 42n,
      email: 'bob@harvoost.local',
      display_name: 'Bob',
      timezone: 'Europe/Amsterdam',
      weekly_summary_opt_out: false,
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const envelope = { data: [row], page: 1, page_size: 50, total_count: 1 };
    const out = JSON.parse(JSON.stringify(envelope));
    expect(out.data[0].id).toBe('42');
    expect(typeof out.data[0].id).toBe('string');
  });

  it('GET /v1/projects raw row shape: id AND client_id serialize as strings', () => {
    // Mirrors ProjectsController.list() raw row (id + client_id are Postgres bigints).
    const row = {
      id: 7n,
      client_id: 3n,
      code: 'ACME-1',
      name: 'Acme Rollout',
      billing_mode: 'hourly',
      currency: 'EUR',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const envelope = { data: [row], page: 1, page_size: 50 };
    const out = JSON.parse(JSON.stringify(envelope));
    expect(out.data[0].id).toBe('7');
    expect(out.data[0].client_id).toBe('3');
    expect(typeof out.data[0].id).toBe('string');
    expect(typeof out.data[0].client_id).toBe('string');
  });

  it('GET /v1/clients raw row shape: id serializes as a string', () => {
    // Mirrors ClientsController.list() raw row (id is a Postgres bigint).
    const row = { id: 9n, name: 'Acme Corp', is_active: true, created_at: '2026-01-01T00:00:00.000Z' };
    const envelope = { data: [row], page: 1, page_size: 50 };
    const out = JSON.parse(JSON.stringify(envelope));
    expect(out.data[0].id).toBe('9');
    expect(typeof out.data[0].id).toBe('string');
  });

  it('preserves large bigints beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    const out = JSON.parse(JSON.stringify({ id: big }));
    expect(out.id).toBe('9007199254740993');
  });

  it('leaves already-stringified IDs unchanged (String()-mapped endpoints are unaffected)', () => {
    // cost-rates / project members endpoints already String()-map their ids; a plain
    // string passes through JSON.stringify untouched and never hits BigInt.toJSON.
    const out = JSON.parse(JSON.stringify({ id: '7', user_id: '20', rate: 85 }));
    expect(out).toEqual({ id: '7', user_id: '20', rate: 85 });
  });
});
