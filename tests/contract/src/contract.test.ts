// OpenAPI-driven FE<->BE contract test (INC-004 prevention, M7 class).
//
// Asserts, statically (no running stack), that:
//   1. every apps/web `apiFetch(path, { query, method })` call resolves to a
//      declared operation in the pinned openapi.yaml (method + path template),
//   2. each such operation is backed by a registered NestJS route in
//      apps/api/src (catches the "route doesn't exist" / 404 class), and
//   3. the FE's query keys are declared parameters of that operation, and
//   4. for the INC-004 load-bearing endpoints, the spec's success-response
//      schema declares every field the FE reads, at the right envelope key
//      (the items/data + project_name/hours drift that broke Rows 1-2).
//
// Run: `pnpm --filter @harvoost/contract test`  (or `pnpm -w test` via turbo).
import { describe, it, expect } from 'vitest';
import { scanFrontend, type FeCall } from './scan-frontend.js';
import { scanBackend } from './scan-backend.js';
import { loadSpec, type SpecOperation } from './load-spec.js';
import { resolveRowProps } from './schema-fields.js';
import {
  LOAD_BEARING,
  KNOWN_PARAM_DRIFT,
  KNOWN_SPEC_GAP,
  KNOWN_ROUTE_GAP,
} from './contract-spec.js';

const spec = loadSpec();
const { calls, unresolved } = scanFrontend();
const backend = scanBackend();
const specGap = new Set(KNOWN_SPEC_GAP);
const routeGap = new Set(KNOWN_ROUTE_GAP);

function opKey(c: { method: string; pathTemplate: string }): string {
  return `${c.method} ${c.pathTemplate}`;
}

/** Dedupe FE calls by method+path (multiple call sites for one endpoint). */
function uniqueCalls(): FeCall[] {
  const seen = new Map<string, FeCall>();
  for (const c of calls) {
    const k = opKey(c);
    if (!seen.has(k)) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => opKey(a).localeCompare(opKey(b)));
}

describe('contract: scan sanity', () => {
  it('loaded the pinned openapi.yaml with operations', () => {
    expect(spec.operations.size).toBeGreaterThan(20);
  });

  it('found apiFetch call sites in apps/web', () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it('found registered NestJS routes in apps/api', () => {
    expect(backend.routes.length).toBeGreaterThan(20);
  });

  it('every apiFetch path argument was statically resolvable to a /v1 path', () => {
    // A /v1 path we could not parse IS a gap worth failing on (we cannot
    // contract-check it). Non-/v1 unresolved entries are informational.
    const hardFailures = unresolved.filter((u) => /is not a static/.test(u.reason));
    expect(
      hardFailures,
      `Unresolvable apiFetch path args (cannot contract-check these):\n` +
        hardFailures.map((u) => `  ${u.file}:${u.line} — ${u.snippet}`).join('\n'),
    ).toHaveLength(0);
  });
});

describe('contract: every FE call maps to a declared openapi operation', () => {
  for (const c of uniqueCalls()) {
    const key = opKey(c);
    const gap = specGap.has(key);
    it(`${key} is declared in openapi.yaml${gap ? ' [known spec gap, relaxed]' : ''} (first seen ${c.file}:${c.line})`, () => {
      if (gap) {
        // Documented out-of-scope debt: route exists but the spec entry is
        // deferred. Still guard that it really is registered in the API.
        expect(
          backend.routeSet.has(key),
          `${key} is in KNOWN_SPEC_GAP but has no registered NestJS route either.`,
        ).toBe(true);
        return;
      }
      const op = spec.operations.get(key);
      expect(
        op,
        `Frontend calls ${key} (${c.file}:${c.line}) but openapi.yaml declares no such ` +
          `operation. Either the FE invented an endpoint, or the spec is missing it.`,
      ).toBeDefined();
    });
  }
});

describe('contract: every declared FE operation has a registered NestJS route (404 guard)', () => {
  for (const c of uniqueCalls()) {
    const key = opKey(c);
    const gap = routeGap.has(key);
    it(`${key} is registered in apps/api/src${gap ? ' [known route gap, relaxed]' : ''}`, () => {
      const found = backend.routeSet.has(key);
      if (gap) {
        // Documented latent 404 outside INC-004 scope. Assert the spec at least
        // still declares it (so the debt is real, not a typo) and move on.
        expect(
          spec.operations.has(key),
          `${key} is in KNOWN_ROUTE_GAP but is not declared in openapi.yaml either.`,
        ).toBe(true);
        return;
      }
      expect(
        found,
        `Frontend calls ${key} (${c.file}:${c.line}) but apps/api/src registers no ` +
          `matching route under the composed @Controller prefix. This is the 404 class ` +
          `INC-004 fixes.\n` +
          `Registered routes for this path:\n` +
          (backend.routes
            .filter((r) => r.pathTemplate === c.pathTemplate)
            .map((r) => `  ${r.method} ${r.pathTemplate} (${r.file})`)
            .join('\n') || '  (none)'),
      ).toBe(true);
    });
  }
});

describe('contract: FE query keys are declared params of the operation', () => {
  for (const c of uniqueCalls()) {
    const key = opKey(c);
    const op = spec.operations.get(key);
    if (!op) continue; // existence/gaps handled above
    if (c.queryKeys.length === 0) continue;

    const declared = new Set(op.params.filter((p) => p.in === 'query').map((p) => p.name));
    const allowedDrift = new Set(KNOWN_PARAM_DRIFT[key] ?? []);
    const undeclared = c.queryKeys.filter((k) => !declared.has(k) && !allowedDrift.has(k));

    it(`${key} query keys are all declared (${c.file}:${c.line})`, () => {
      expect(
        undeclared,
        `Frontend sends query keys not declared on ${key}: ` +
          `[${undeclared.join(', ')}]. Declared: [${[...declared].join(', ')}]. ` +
          `If this is intentional, add the param to openapi.yaml; if it is known ` +
          `out-of-scope debt, add it to KNOWN_PARAM_DRIFT.`,
      ).toHaveLength(0);
    });
  }
});

describe('contract: load-bearing endpoints exist and read-fields match the spec', () => {
  for (const exp of LOAD_BEARING) {
    const op = spec.operations.get(exp.key) as SpecOperation | undefined;

    it(`${exp.key} is declared + routed`, () => {
      expect(op, `${exp.key} missing from openapi.yaml`).toBeDefined();
      expect(
        backend.routeSet.has(exp.key),
        `${exp.key} declared in spec but not registered in apps/api/src`,
      ).toBe(true);
    });

    it(`${exp.key} success schema declares the FE-read fields under "${exp.envelopeKey || '(root)'}"`, () => {
      if (!op) return; // covered by the existence assertion above
      expect(
        op.successSchema,
        `${exp.key} has no 2xx application/json response schema in the spec`,
      ).toBeDefined();

      const props = resolveRowProps(spec.raw, op.successSchema, exp.envelopeKey, exp.shape);
      const declared = Object.keys(props);
      const missing = exp.reads.filter((f) => !declared.includes(f));
      expect(
        missing,
        `${exp.key} response schema is missing FE-read fields [${missing.join(', ')}] ` +
          `at envelope "${exp.envelopeKey || '(root)'}". Spec declares: [${declared.join(', ')}]. ` +
          `This is exactly the items/data + project_name/hours envelope drift INC-004 fixes.`,
      ).toHaveLength(0);
    });
  }
});

// A human-readable enumeration so a failing CI log shows the full picture.
describe('contract: enumeration (informational)', () => {
  it('prints the FE call inventory + any unresolved calls', () => {
    const lines: string[] = [];
    lines.push(`Frontend apiFetch calls (${uniqueCalls().length} unique):`);
    for (const c of uniqueCalls()) {
      const key = opKey(c);
      const inSpec = spec.operations.has(key)
        ? 'spec✓'
        : specGap.has(key)
          ? 'spec~gap'
          : 'spec✗';
      const inApi = backend.routeSet.has(key)
        ? 'route✓'
        : routeGap.has(key)
          ? 'route~gap'
          : 'route✗';
      lines.push(
        `  ${key.padEnd(48)} ${inSpec.padEnd(8)} ${inApi.padEnd(9)} q=[${c.queryKeys.join(',')}]`,
      );
    }
    if (unresolved.length) {
      lines.push(`\nUnresolved / non-/v1 apiFetch calls (${unresolved.length}):`);
      for (const u of unresolved) lines.push(`  ${u.file}:${u.line} — ${u.reason}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(true).toBe(true);
  });
});
