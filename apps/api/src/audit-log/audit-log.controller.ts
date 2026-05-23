import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('v1/audit-log')
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('admin', 'finmgr')
  @Get()
  async list(
    @Query('entity_type') entityType?: string,
    @Query('actor_id') actorId?: string,
    @Query('limit') limit = '50',
  ) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (entityType) {
      params.push(entityType);
      wheres.push(`entity_type = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      wheres.push(`actor_id = $${params.length}::bigint`);
    }
    params.push(lim);
    const sql = `SELECT id, actor_id, action, entity_type, entity_id, before, after, reason, created_at
                 FROM audit_log ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT $${params.length}::int`;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
    return { data: rows };
  }
}
