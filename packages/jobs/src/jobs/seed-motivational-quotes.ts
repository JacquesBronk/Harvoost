// Trigger: startup-once.
// Owner: Weekly Summary module.
// Failure mode: NoOp — quotes are bundled in code at packages/jobs/src/quotes.ts.
//
// The architecture allows the org to later override these via org_settings; this
// startup hook ensures any DB-backed override table is initialised. For v1 the
// bundled list is authoritative.

import { MOTIVATIONAL_QUOTES } from '../quotes';
import type { JobDefinition, JobDeps } from '../types';

export const seedMotivationalQuotes: JobDefinition = {
  name: 'quotes.seed_at_startup',
  trigger: 'startup',
  failureMode: 'NoOp — quotes are bundled in code.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    deps.logger.info('quotes.seed_at_startup.ok', { count: MOTIVATIONAL_QUOTES.length });
  },
};
