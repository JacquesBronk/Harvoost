import { describe, it, expect, vi } from 'vitest';
import { MoodController } from '../../src/mood/mood.controller';
import { KAnonymityError, ValidationFailedError } from '@harvoost/shared';
import type { RbacScopeService } from '@harvoost/shared';

function makePrisma(opts: { sampleSize?: number; uniqueOnInsert?: boolean }) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT timezone FROM users')) {
        return [{ timezone: 'Africa/Johannesburg' }];
      }
      if (sql.includes('COUNT(DISTINCT user_id)') && sql.includes('mood_entries')) {
        return [{ sample_size: opts.sampleSize ?? 5, score_avg: 3.5 }];
      }
      if (sql.includes('SELECT id, user_id, local_date, score')) {
        return []; // empty own history
      }
      if (sql.includes('INSERT INTO mood_entries')) {
        if (opts.uniqueOnInsert) {
          throw new Error('duplicate key value violates unique constraint "mood_entries_user_id_local_date_key"');
        }
        return [{ id: '1', user_id: '101', local_date: '2026-05-22', score: 4, created_at: new Date() }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbac(unrestricted = false): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: ['101', '102', '103'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted }),
  } as unknown as RbacScopeService;
}

describe('POST /v1/mood/entries — once-per-day enforcement (REQUIREMENTS F1.3)', () => {
  const user = { userId: '101', email: 'e@h.local', roles: ['employee'] };

  it('records a mood entry on the first call of the day', async () => {
    const prisma = makePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    const out = await ctrl.record(user, { score: 4 });
    expect(out).toMatchObject({ score: 4 });
  });

  it('returns VALIDATION_FAILED when a duplicate (user, local_date) violates the UNIQUE constraint', async () => {
    const prisma = makePrisma({ uniqueOnInsert: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    await expect(ctrl.record(user, { score: 4 })).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('GET /v1/mood/team/aggregate — k>=5 enforcement', () => {
  const manager = { userId: '101', email: 'm@h.local', roles: ['manager'] };

  it('returns the aggregate when sample_size >= 5', async () => {
    const prisma = makePrisma({ sampleSize: 5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    const out = await ctrl.teamAggregate(manager, { date_from: '2026-05-01', date_to: '2026-05-22' });
    expect(out.data[0]).toMatchObject({ sample_size: 5, score_avg: 3.5 });
  });

  it('throws K_ANONYMITY_THRESHOLD when sample_size < 5 (REQUIREMENTS § Security § Mood data)', async () => {
    const prisma = makePrisma({ sampleSize: 4 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    await expect(
      ctrl.teamAggregate(manager, { date_from: '2026-05-01', date_to: '2026-05-22' }),
    ).rejects.toBeInstanceOf(KAnonymityError);
  });

  it('throws K_ANONYMITY_THRESHOLD when sample_size is zero', async () => {
    const prisma = makePrisma({ sampleSize: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    await expect(
      ctrl.teamAggregate(manager, { date_from: '2026-05-01', date_to: '2026-05-22' }),
    ).rejects.toBeInstanceOf(KAnonymityError);
  });

  it('includes scope_meta for the empty-state UI', async () => {
    const prisma = makePrisma({ sampleSize: 5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    const out = await ctrl.teamAggregate(manager, { date_from: '2026-05-01', date_to: '2026-05-22' });
    expect(out.scope_meta).toBeDefined();
    expect(out.scope_meta.visible_users).toBe(3);
  });
});

describe('GET /v1/mood/me — own only (REQUIREMENTS § Security § Mood data)', () => {
  it('queries only the requester user_id', async () => {
    const prisma = makePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new MoodController(prisma as any, makeRbac());
    const user = { userId: '101', email: 'e@h.local', roles: ['employee'] };
    await ctrl.getOwn(user);
    const ownQuery = (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('FROM mood_entries'),
    );
    expect(ownQuery).toBeDefined();
    // Verify the user_id parameter is the requester (not arbitrary).
    expect(ownQuery![1]).toBe('101');
    // And the WHERE clause must filter by user_id.
    expect(String(ownQuery![0])).toMatch(/user_id = \$1/);
  });
});
