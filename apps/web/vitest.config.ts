import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use the automatic JSX runtime so component modules (.tsx) imported by tests
  // compile without requiring `React` in scope. INC-002: Avatar render tests.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
