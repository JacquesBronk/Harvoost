import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DateTime } from 'luxon';
import {
  enforceKAnonymity,
  localDateFor,
  RbacScopeService,
  ValidationFailedError,
} from '@harvoost/shared';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';

const RecordSchema = z.object({ score: z.number().int().min(1).max(5) });
const AggregateQuery = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  project_id: z.string().optional(),
});

@Controller('v1/mood')
export class MoodController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
  ) {}

  @Post('entries')
  async record(@CurrentUser() user: CurrentUserPayload, @Body(new ZodValidationPipe(RecordSchema)) body: z.infer<typeof RecordSchema>) {
    // Look up user TZ.
    const tzRows = await this.prisma.$queryRawUnsafe<Array<{ timezone: unknown }>>(
      `SELECT timezone FROM users WHERE id = $1::bigint LIMIT 1`,
      user.userId,
    );
    const tz = tzRows.length > 0 ? String(tzRows[0]!.timezone) : 'Africa/Johannesburg';
    const localDate = localDateFor(DateTime.utc(), tz);
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `INSERT INTO mood_entries (user_id, local_date, score)
         VALUES ($1::bigint, $2::date, $3::int)
         RETURNING id, user_id, local_date, score, created_at`,
        user.userId,
        localDate,
        body.score,
      );
      return rows[0];
    } catch (err) {
      // UNIQUE (user_id, local_date) violation → 409.
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw new ValidationFailedError(`Mood for ${localDate} already exists.`);
      }
      throw err;
    }
  }

  @Get('me')
  async getOwn(@CurrentUser() user: CurrentUserPayload, @Query('date_from') from?: string, @Query('date_to') to?: string) {
    const params: unknown[] = [user.userId];
    let where = `user_id = $1::bigint`;
    if (from) {
      params.push(from);
      where += ` AND local_date >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      where += ` AND local_date <= $${params.length}::date`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, user_id, local_date, score, created_at FROM mood_entries
       WHERE ${where} ORDER BY local_date DESC LIMIT 500`,
      ...params,
    );
    return { data: rows };
  }

  @Get('team/aggregate')
  async teamAggregate(
    @CurrentUser() user: CurrentUserPayload,
    @Query(new ZodValidationPipe(AggregateQuery)) q: z.infer<typeof AggregateQuery>,
  ) {
    const visibleUsers = await this.rbac.getVisibleUserIds(user.userId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const params: unknown[] = [q.date_from, q.date_to];
    let where = `local_date >= $1::date AND local_date <= $2::date`;
    if (userIds) {
      params.push(userIds);
      where += ` AND user_id = ANY($${params.length}::bigint[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ sample_size: unknown; score_avg: unknown }>>(
      `SELECT COUNT(DISTINCT user_id)::int AS sample_size, AVG(score)::numeric(3,2) AS score_avg
       FROM mood_entries WHERE ${where}`,
      ...params,
    );
    const sampleSize = Number(rows[0]?.sample_size ?? 0);
    enforceKAnonymity(sampleSize, 5);
    return {
      data: [{
        sample_size: sampleSize,
        score_avg: Number(rows[0]?.score_avg ?? 0),
        date_from: q.date_from,
        date_to: q.date_to,
      }],
      scope_meta: {
        visible_users: visibleUsers.unrestricted ? -1 : visibleUsers.userIds.length,
        visible_projects: -1,
      },
    };
  }
}
