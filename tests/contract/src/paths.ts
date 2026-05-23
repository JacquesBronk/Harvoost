// Resolve the repo-relative locations the contract scanners need.
//
// The contract package lives at <repo>/tests/contract, so the repo root is two
// directories up from this file's directory. We resolve everything from there
// so the test is robust to the cwd the runner uses (turbo runs it from the
// package dir; a direct `vitest` invocation may differ).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // tests/contract/src
export const REPO_ROOT = resolve(here, '..', '..', '..'); // <repo>

export const WEB_SRC_DIRS = [
  resolve(REPO_ROOT, 'apps/web/app'),
  resolve(REPO_ROOT, 'apps/web/src'),
];

export const API_SRC_DIR = resolve(REPO_ROOT, 'apps/api/src');

// The canonical pinned OpenAPI contract. This run's spec lives under the
// hacktogether run folder; if that is ever relocated to a stable repo path
// (e.g. docs/openapi.yaml) add it to the candidate list below.
const SPEC_CANDIDATES = [
  resolve(
    REPO_ROOT,
    '.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml',
  ),
  resolve(REPO_ROOT, '03-api-design/openapi.yaml'),
  resolve(REPO_ROOT, 'docs/openapi.yaml'),
];

export function resolveSpecPath(): string {
  const found = SPEC_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find openapi.yaml. Looked in:\n  ${SPEC_CANDIDATES.join('\n  ')}`,
    );
  }
  return found;
}
