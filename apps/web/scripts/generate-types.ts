#!/usr/bin/env tsx
/**
 * Generate TypeScript types from the Harvoost OpenAPI spec.
 *
 * Run via:
 *   pnpm --filter @harvoost/web generate-types
 *
 * Output: src/lib/api-types.gen.ts
 *
 * Requires `openapi-typescript` as a dev dependency.
 *
 * NOTE: The spec lives in the hacktogether run folder. This script
 * resolves the most recently-completed run by reading the
 * `current_phase` field in RUN_STATE.md. For local dev you can
 * override with HARVOOST_OPENAPI_PATH.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function findOpenApiSpec(): string {
  const envOverride = process.env.HARVOOST_OPENAPI_PATH;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const runsDir = resolve(process.cwd(), '..', '..', '.hacktogether', 'runs');
  if (!existsSync(runsDir)) {
    throw new Error(
      `Could not find .hacktogether/runs at ${runsDir}. Set HARVOOST_OPENAPI_PATH explicitly.`,
    );
  }
  const runs = readdirSync(runsDir)
    .map((name) => ({ name, path: join(runsDir, name) }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .map((entry) => ({
      ...entry,
      mtime: statSync(entry.path).mtimeMs,
      spec: join(entry.path, '03-api-design', 'openapi.yaml'),
    }))
    .filter((entry) => existsSync(entry.spec))
    .sort((a, b) => b.mtime - a.mtime);

  if (runs.length === 0) {
    throw new Error(
      'No openapi.yaml found in any hacktogether run. Set HARVOOST_OPENAPI_PATH explicitly.',
    );
  }
  return runs[0]!.spec;
}

const specPath = findOpenApiSpec();
const outPath = resolve(process.cwd(), 'src', 'lib', 'api-types.gen.ts');

// eslint-disable-next-line no-console
console.log(`[generate-types] spec: ${specPath}`);
// eslint-disable-next-line no-console
console.log(`[generate-types] out:  ${outPath}`);

const result = spawnSync(
  'npx',
  ['openapi-typescript', specPath, '--output', outPath],
  { stdio: 'inherit', shell: true },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
