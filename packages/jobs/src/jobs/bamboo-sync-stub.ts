// Trigger: cron 0 5 * * * (daily 05:00 UTC).
// Owner: Leave module.
// Failure mode: NoOp in v1 — only logs how many leave_requests would be synced.
//
// Implements the LeaveSyncProvider seam (NoOp impl). Bamboo bridge is v2.

import type { JobDefinition, JobDeps } from '../types';

export const bambooSyncStub: JobDefinition = {
  name: 'leave.bamboo_sync_stub',
  cron: '0 5 * * *',
  trigger: 'cron',
  failureMode: 'NoOp v1 — never fails substantively.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const rows = await deps.prisma.$queryRawUnsafe<Array<{ pending: unknown }>>(
      `SELECT COUNT(*)::int AS pending FROM leave_requests WHERE bamboo_sync_status = 'pending'`,
    );
    deps.logger.info('leave.bamboo_sync_stub.ok', { wouldSync: Number(rows[0]?.pending ?? 0) });
  },
};
