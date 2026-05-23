/**
 * @harvoost/db — typed Prisma client + shared fixtures.
 *
 * Re-exports:
 *   - PrismaClient and all generated model types from @prisma/client
 *   - Prisma error class shortcuts
 *   - RBAC_TEST_FIXTURE — the canonical Alice/Bob/Carol/Dave fixture used by
 *     RBAC tests across the monorepo. The values are seeded into the dev DB by
 *     `pnpm db:seed`; downstream tests can import this constant to assert
 *     visibility expectations without re-declaring the topology.
 */

export * from '@prisma/client';
export { Prisma, PrismaClient } from '@prisma/client';

// Singleton-friendly factory: many test/runtime contexts want a single
// PrismaClient instance to avoid exhausting Postgres connections. Importers
// can call `getPrismaClient()` or instantiate their own — both supported.
import { PrismaClient } from '@prisma/client';

let _client: PrismaClient | undefined;

export function getPrismaClient(opts?: ConstructorParameters<typeof PrismaClient>[0]): PrismaClient {
  if (!_client) {
    _client = new PrismaClient(opts);
  }
  return _client;
}

export { RBAC_TEST_FIXTURE } from './fixtures';
export type { RbacTestFixture, RbacFixtureUser, RbacFixtureProject } from './fixtures';
