/**
 * Root ESLint config — minimal. Each app/package extends and adds its own
 * framework-specific rules (Next.js, NestJS, React Native via Electron, etc.).
 *
 * Why minimal here: the build phase wants per-lane teams to own their own
 * lint config. The root config exists so `pnpm lint` at the root doesn't error
 * out for projects without a local config.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    '.next',
    'build',
    'coverage',
    '.turbo',
    'packages/db/prisma/migrations/**/*.sql',
    'infra/bicep/**/*.bicep',
  ],
  rules: {
    'no-console': 'off',
  },
};
