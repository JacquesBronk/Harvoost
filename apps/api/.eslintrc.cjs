/**
 * apps/api ESLint config — extends the root and adds NestJS-friendly conventions.
 *
 * TODO(build-phase-followup): custom rule "no-unscoped-prisma-query" to fail the build
 * when a Prisma query against time_entries, mood_entries, leave_requests, exceptions,
 * or chatbot_conversations is missing a userId/projectId IN filter. The sanctioned
 * escape hatch is `withSelfScope(userId)` from @harvoost/shared. For now, the
 * RbacGuard logs a runtime warning when a scope-bearing endpoint returns
 * unfiltered data — see RbacScopeService.assertCanSeeUser/Project.
 *
 * Plan when implementing the rule (record-only here, do not implement):
 *   1. Walk AST for CallExpression nodes against `prisma.$queryRawUnsafe`.
 *   2. Match the SQL text against /from\s+(time_entries|mood_entries|leave_requests|exceptions|chatbot_conversations)/i.
 *   3. Require either: (a) `user_id = ` referencing a current-scope variable, OR
 *      (b) `withSelfScope(` upstream in the function, OR (c) `getVisibleUserIds`/`getVisibleProjectIds`
 *      called and the result used as an `ANY(... ::bigint[])` filter.
 *   4. Fail otherwise with a clear message + link to ARCHITECTURE.md § RBAC enforcement strategy.
 */
module.exports = {
  root: false,
  extends: ['../../.eslintrc.cjs'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'coverage', 'node_modules', '.turbo'],
  rules: {
    // Defence-in-depth: warn (not error) when raw SQL is constructed via template strings.
    'no-template-curly-in-string': 'warn',
  },
};
