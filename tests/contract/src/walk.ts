import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively collect files under `roots` whose names match `extensions`.
 * Skips node_modules / .next / dist / build / coverage / __tests__.
 */
export function collectFiles(roots: string[], extensions: string[]): string[] {
  const out: string[] = [];
  const skipDirs = new Set([
    'node_modules',
    '.next',
    'dist',
    'build',
    'coverage',
    '.turbo',
    '__tests__',
    '__mocks__',
  ]);

  function recurse(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!skipDirs.has(entry)) recurse(full);
      } else if (extensions.some((e) => entry.endsWith(e))) {
        // Skip test/spec files themselves.
        if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
        out.push(full);
      }
    }
  }

  for (const r of roots) recurse(r);
  return out.sort();
}
