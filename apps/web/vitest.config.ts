import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use the automatic JSX runtime so component modules (.tsx) imported by tests
  // compile without requiring `React` in scope. INC-002: Avatar render tests.
  esbuild: { jsx: 'automatic' },
  // INC-007: mirror the tsconfig `@/* -> ./src/*` path so node-env tests that
  // render real component modules can resolve their runtime `@/...` imports
  // (e.g. the rollup-view helpers import `@/lib/tz.js`). Type-only `@/` imports
  // are stripped by esbuild and never reached the resolver before.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
