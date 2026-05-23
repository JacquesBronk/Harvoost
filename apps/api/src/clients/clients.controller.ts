import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { AuditService } from '../common/audit/audit.service';
import { ValidationFailedError } from '@harvoost/shared';

const CreateClientSchema = z.object({ name: z.string().min(1).max(200) });

@Controller('v1/clients')
export class ClientsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query('page') page = '1', @Query('page_size') pageSize = '50') {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, name, is_active, created_at FROM clients WHERE is_active = TRUE ORDER BY name LIMIT $1::int OFFSET $2::int`,
      ps,
      (p - 1) * ps,
    );
    return { data: rows, page: p, page_size: ps };
  }

  @Roles('admin', 'finmgr')
  @Post()
  async create(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(CreateClientSchema)) body: z.infer<typeof CreateClientSchema>,
  ) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `INSERT INTO clients (name) VALUES ($1) RETURNING id`,
      body.name,
    );
    const newId = String(rows[0]!.id);
    await this.audit.record({
      actorId: actor.userId,
      action: 'client.create',
      entityType: 'client',
      entityId: newId,
      after: { name: body.name },
    });
    return { id: newId };
  }

  @Roles('admin', 'finmgr')
  @Patch(':id')
  async update(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: { name?: string; is_active?: boolean }) {
    const fields: string[] = [];
    const params: unknown[] = [];
    const after: Record<string, unknown> = {};
    if (body.name !== undefined) {
      params.push(body.name);
      fields.push(`name = $${params.length}`);
      after.name = body.name;
    }
    if (body.is_active !== undefined) {
      params.push(body.is_active);
      fields.push(`is_active = $${params.length}`);
      after.is_active = body.is_active;
    }
    if (fields.length === 0) return { ok: true };
    params.push(id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE clients SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::bigint`,
      ...params,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'client.update',
      entityType: 'client',
      entityId: id,
      after,
    });
    return { ok: true };
  }

  // DELETE /v1/clients/{id} → hard delete.
  // FK-GUARD: projects.client_id REFERENCES clients(id) ON DELETE RESTRICT, so
  // deleting a client that still has projects raises Postgres 23503
  // (foreign_key_violation). Map that to a clean domain error instead of a raw
  // 500 — mirrors the 23P01 → ValidationFailedError pattern in
  // billable-rates.controller.ts. Admin-only per INC-004 scope (deletion is a
  // narrower grant than the create/update FinMgr can perform — do NOT widen).
  // Audit on success only.
  @Roles('admin')
  @Delete(':id')
  async remove(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string) {
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM clients WHERE id = $1::bigint`,
        id,
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === '23503' || /foreign key|23503/i.test(message)) {
        throw new ValidationFailedError(
          'Cannot delete a client that still has projects. Reassign or archive its projects first.',
          { code: 'CLIENT_HAS_PROJECTS' },
        );
      }
      throw err;
    }
    await this.audit.record({
      actorId: actor.userId,
      action: 'client.delete',
      entityType: 'client',
      entityId: id,
    });
    return { ok: true };
  }
}
