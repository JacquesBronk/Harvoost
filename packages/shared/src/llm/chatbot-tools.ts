import { z } from 'zod';
import type { RbacScopeService } from '../rbac/RbacScopeService';
import { RbacForbiddenError } from '../rbac/errors';
import { enforceKAnonymity, KAnonymityError } from '../rbac/k-anonymity';
import type { ToolDef } from './LLMProvider';

// Prisma shape used by tools — kept narrow to avoid pulling Prisma into shared.
// We use $queryRawUnsafe with parameterized bindings (never string interpolation).
export interface ChatbotPrismaLike {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

// Shared date_range schema reused by most tools.
const DateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
});

// Common wrapper: catch RbacForbiddenError and translate to structured error result.
// Tools NEVER throw to the LLM — the orchestrator depends on tools returning
// objects so the LLM can apologise gracefully.
function safe<T>(fn: () => Promise<T>): Promise<T | { error: string; message: string }> {
  return fn().catch((err) => {
    if (err instanceof RbacForbiddenError) {
      return { error: 'out_of_scope', message: 'You do not have access to that data.' };
    }
    if (err instanceof KAnonymityError) {
      return { error: 'k_anonymity', message: 'Not enough data — fewer than 5 contributing users.' };
    }
    return {
      error: 'tool_error',
      message: err instanceof Error ? err.message : String(err),
    };
  });
}

// requesterId is bound here, NEVER exposed as a JSON-schema param.
export type ChatbotToolFactory = (
  requesterId: string,
  prisma: ChatbotPrismaLike,
  rbac: RbacScopeService,
) => ToolDef;

// ---------------------------------------------------------------------------
// 1. get_user_hours
// ---------------------------------------------------------------------------
export const getUserHoursTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'get_user_hours',
  description: 'Get total hours logged by a user in a date range. Defaults to the requesting user if user_id is omitted.',
  parameters: z.object({
    user_id: z.string().optional(),
    date_range: DateRange,
  }),
  execute: async (input) => safe(async () => {
    const args = input as { user_id?: string; date_range: { from: string; to: string } };
    const targetId = args.user_id ?? requesterId;
    if (targetId !== requesterId) {
      await rbac.assertCanSeeUser(requesterId, targetId);
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ total_hours: unknown }>>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS total_hours
       FROM time_entries
       WHERE user_id = $1::bigint
         AND start_at >= $2::date
         AND start_at < ($3::date + INTERVAL '1 day')
         AND end_at IS NOT NULL`,
      targetId,
      args.date_range.from,
      args.date_range.to,
    );
    const total = Number(rows[0]?.total_hours ?? 0);
    return { user_id: targetId, total_hours: total, date_range: args.date_range };
  }),
});

// ---------------------------------------------------------------------------
// 2. list_my_projects
// ---------------------------------------------------------------------------
export const listMyProjectsTool: ChatbotToolFactory = (requesterId, prisma, _rbac) => ({
  name: 'list_my_projects',
  description: 'List the projects the requesting user is currently a member of.',
  parameters: z.object({
    date_range: DateRange.optional(),
  }),
  execute: async () => safe(async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: unknown; name: unknown; code: unknown }>>(
      `SELECT p.id, p.name, p.code
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1::bigint
         AND pm.left_at IS NULL
         AND p.is_active = TRUE
       ORDER BY p.name`,
      requesterId,
    );
    return {
      projects: rows.map((r) => ({ id: String(r.id), name: String(r.name), code: r.code ? String(r.code) : null })),
    };
  }),
});

// ---------------------------------------------------------------------------
// 3. project_rollup
// ---------------------------------------------------------------------------
export const projectRollupTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'project_rollup',
  description: 'Sum of hours per user for a project in a date range. RBAC-scoped.',
  parameters: z.object({
    project_id: z.string(),
    date_range: DateRange,
  }),
  execute: async (input) => safe(async () => {
    const args = input as { project_id: string; date_range: { from: string; to: string } };
    await rbac.assertCanSeeProject(requesterId, args.project_id);
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const rows = await prisma.$queryRawUnsafe<Array<{ user_id: unknown; total_hours: unknown }>>(
      `SELECT user_id,
              SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0) AS total_hours
       FROM time_entries
       WHERE project_id = $1::bigint
         AND end_at IS NOT NULL
         AND start_at >= $2::date
         AND start_at < ($3::date + INTERVAL '1 day')
         ${userIds ? `AND user_id = ANY($4::bigint[])` : ''}
       GROUP BY user_id`,
      args.project_id,
      args.date_range.from,
      args.date_range.to,
      ...(userIds ? [userIds] : []),
    );
    return {
      project_id: args.project_id,
      rows: rows.map((r) => ({ user_id: String(r.user_id), hours: Number(r.total_hours ?? 0) })),
    };
  }),
});

// ---------------------------------------------------------------------------
// 4. list_exceptions
// ---------------------------------------------------------------------------
export const listExceptionsTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'list_exceptions',
  description: 'List exceptions (missed-punch, overtime, anomaly) for the requesting user\'s visible scope.',
  parameters: z.object({
    type: z.enum(['MISSED_PUNCH', 'OVERTIME_DAY', 'OVERTIME_WEEK', 'ANOMALY_LOW', 'ANOMALY_HIGH']).optional(),
    date_range: DateRange,
  }),
  execute: async (input) => safe(async () => {
    const args = input as {
      type?: string;
      date_range: { from: string; to: string };
    };
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const rows = await prisma.$queryRawUnsafe<
      Array<{ user_id: unknown; exception_type: unknown; local_date: unknown; status: unknown }>
    >(
      `SELECT user_id, exception_type, local_date, status
       FROM exceptions
       WHERE local_date >= $1::date AND local_date <= $2::date
         ${userIds ? `AND user_id = ANY($3::bigint[])` : ''}
         ${args.type ? `AND exception_type = $${userIds ? 4 : 3}` : ''}
       ORDER BY local_date DESC
       LIMIT 50`,
      args.date_range.from,
      args.date_range.to,
      ...(userIds ? [userIds] : []),
      ...(args.type ? [args.type] : []),
    );
    return {
      rows: rows.map((r) => ({
        user_id: String(r.user_id),
        type: String(r.exception_type),
        local_date: String(r.local_date),
        status: String(r.status),
      })),
    };
  }),
});

// ---------------------------------------------------------------------------
// 5. team_summary — manager-scoped totals
// ---------------------------------------------------------------------------
export const teamSummaryTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'team_summary',
  description: 'Aggregated team totals (hours by user) over a date range, scoped to the requester\'s visibility.',
  parameters: z.object({
    date_range: DateRange,
  }),
  execute: async (input) => safe(async () => {
    const args = input as { date_range: { from: string; to: string } };
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    if (!visibleUsers.unrestricted && userIds!.length === 0) {
      return { rows: [], total_users: 0 };
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ user_id: unknown; total_hours: unknown }>>(
      `SELECT user_id, SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0) AS total_hours
       FROM time_entries
       WHERE end_at IS NOT NULL
         AND start_at >= $1::date
         AND start_at < ($2::date + INTERVAL '1 day')
         ${userIds ? `AND user_id = ANY($3::bigint[])` : ''}
       GROUP BY user_id
       ORDER BY total_hours DESC`,
      args.date_range.from,
      args.date_range.to,
      ...(userIds ? [userIds] : []),
    );
    return {
      rows: rows.map((r) => ({ user_id: String(r.user_id), hours: Number(r.total_hours ?? 0) })),
      total_users: rows.length,
    };
  }),
});

// ---------------------------------------------------------------------------
// 6. top_billable_projects — finmgr/admin only
// ---------------------------------------------------------------------------
export const topBillableProjectsTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'top_billable_projects',
  description: 'Top billable projects by revenue in a date range (finmgr/admin only).',
  parameters: z.object({
    date_range: DateRange,
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (input) => safe(async () => {
    const isAdmin = await rbac.canActAsRole(requesterId, 'admin');
    const isFin = await rbac.canActAsRole(requesterId, 'finmgr');
    if (!isAdmin && !isFin) throw new RbacForbiddenError();
    const args = input as { date_range: { from: string; to: string }; limit: number };
    const rows = await prisma.$queryRawUnsafe<Array<{ project_id: unknown; total_hours: unknown }>>(
      `SELECT project_id, SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0) AS total_hours
       FROM time_entries
       WHERE end_at IS NOT NULL
         AND billable = TRUE
         AND start_at >= $1::date
         AND start_at < ($2::date + INTERVAL '1 day')
       GROUP BY project_id
       ORDER BY total_hours DESC
       LIMIT $3::int`,
      args.date_range.from,
      args.date_range.to,
      args.limit,
    );
    return {
      rows: rows.map((r) => ({ project_id: String(r.project_id), hours: Number(r.total_hours ?? 0) })),
    };
  }),
});

// ---------------------------------------------------------------------------
// 7. find_user_by_name — returns user_id ONLY if visible to requester.
// ---------------------------------------------------------------------------
export const findUserByNameTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'find_user_by_name',
  description: 'Look up a user by display name or email. Returns the user id only if visible to the requester; otherwise returns found:false to avoid leaking existence.',
  parameters: z.object({ name: z.string().min(1) }),
  execute: async (input) => safe(async () => {
    const args = input as { name: string };
    const rows = await prisma.$queryRawUnsafe<Array<{ id: unknown; display_name: unknown }>>(
      `SELECT id, display_name FROM users
       WHERE is_active = TRUE
         AND (LOWER(display_name) = LOWER($1) OR LOWER(email) = LOWER($1))
       LIMIT 2`,
      args.name,
    );
    if (rows.length !== 1) {
      return { found: false };
    }
    const uid = String(rows[0]!.id);
    const visible = await rbac.getVisibleUserIds(requesterId);
    if (!visible.unrestricted && !visible.userIds.includes(uid)) {
      return { found: false };
    }
    return { found: true, user_id: uid, display_name: String(rows[0]!.display_name) };
  }),
});

// ---------------------------------------------------------------------------
// 8. find_project_by_name
// ---------------------------------------------------------------------------
export const findProjectByNameTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'find_project_by_name',
  description: 'Look up a project by name or project code, scoped to the requester\'s visibility.',
  parameters: z.object({ name: z.string().min(1) }),
  execute: async (input) => safe(async () => {
    const args = input as { name: string };
    const rows = await prisma.$queryRawUnsafe<Array<{ id: unknown; name: unknown; code: unknown }>>(
      `SELECT id, name, code FROM projects
       WHERE is_active = TRUE
         AND (LOWER(name) = LOWER($1) OR LOWER(COALESCE(code, '')) = LOWER($1))
       LIMIT 2`,
      args.name,
    );
    if (rows.length !== 1) return { found: false };
    const pid = String(rows[0]!.id);
    const visible = await rbac.getVisibleProjectIds(requesterId);
    if (!visible.unrestricted && !visible.projectIds.includes(pid)) {
      return { found: false };
    }
    return { found: true, project_id: pid, name: String(rows[0]!.name), code: rows[0]!.code ? String(rows[0]!.code) : null };
  }),
});

// ---------------------------------------------------------------------------
// 9. get_user_schedule
// ---------------------------------------------------------------------------
export const getUserScheduleTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'get_user_schedule',
  description: 'Get the schedule template + overrides for a user on a given date (defaults to requesting user).',
  parameters: z.object({
    user_id: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  execute: async (input) => safe(async () => {
    const args = input as { user_id?: string; date: string };
    const targetId = args.user_id ?? requesterId;
    if (targetId !== requesterId) await rbac.assertCanSeeUser(requesterId, targetId);
    const tpl = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT working_days, start_time, end_time, lunch_start_time, lunch_end_time
       FROM schedule_templates WHERE user_id = $1::bigint LIMIT 1`,
      targetId,
    );
    return { user_id: targetId, date: args.date, template: tpl[0] ?? null };
  }),
});

// ---------------------------------------------------------------------------
// 10. list_overtime
// ---------------------------------------------------------------------------
export const listOvertimeTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'list_overtime',
  description: 'List OVERTIME_DAY/OVERTIME_WEEK exceptions for the requester\'s visible scope.',
  parameters: z.object({
    date_range: DateRange,
    scope: z.enum(['day', 'week', 'both']).default('both'),
  }),
  execute: async (input) => safe(async () => {
    const args = input as { date_range: { from: string; to: string }; scope: string };
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const types =
      args.scope === 'day' ? ['OVERTIME_DAY'] : args.scope === 'week' ? ['OVERTIME_WEEK'] : ['OVERTIME_DAY', 'OVERTIME_WEEK'];
    const rows = await prisma.$queryRawUnsafe<Array<{ user_id: unknown; exception_type: unknown; local_date: unknown }>>(
      `SELECT user_id, exception_type, local_date
       FROM exceptions
       WHERE local_date >= $1::date AND local_date <= $2::date
         AND exception_type = ANY($3::text[])
         ${userIds ? `AND user_id = ANY($4::bigint[])` : ''}
       ORDER BY local_date DESC LIMIT 100`,
      args.date_range.from,
      args.date_range.to,
      types,
      ...(userIds ? [userIds] : []),
    );
    return {
      rows: rows.map((r) => ({
        user_id: String(r.user_id),
        type: String(r.exception_type),
        local_date: String(r.local_date),
      })),
    };
  }),
});

// ---------------------------------------------------------------------------
// 11. mood_trend — aggregate with k>=5 enforced.
// ---------------------------------------------------------------------------
export const moodTrendTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'mood_trend',
  description: 'Aggregated mood trend (team or org). Returns an error if fewer than 5 distinct users contribute (k-anonymity).',
  parameters: z.object({
    group: z.enum(['team', 'org']),
    date_range: DateRange,
  }),
  execute: async (input) => safe(async () => {
    const args = input as { group: 'team' | 'org'; date_range: { from: string; to: string } };
    if (args.group === 'org') {
      const okAdmin = await rbac.canActAsRole(requesterId, 'admin');
      const okFin = await rbac.canActAsRole(requesterId, 'finmgr');
      if (!okAdmin && !okFin) throw new RbacForbiddenError();
    }
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const rows = await prisma.$queryRawUnsafe<Array<{ sample_size: unknown; score_avg: unknown }>>(
      `SELECT COUNT(DISTINCT user_id)::int AS sample_size, AVG(score)::numeric(3,2) AS score_avg
       FROM mood_entries
       WHERE local_date >= $1::date AND local_date <= $2::date
         ${userIds ? `AND user_id = ANY($3::bigint[])` : ''}`,
      args.date_range.from,
      args.date_range.to,
      ...(userIds ? [userIds] : []),
    );
    const sampleSize = Number(rows[0]?.sample_size ?? 0);
    enforceKAnonymity(sampleSize, 5);
    return {
      sample_size: sampleSize,
      score_avg: Number(rows[0]?.score_avg ?? 0),
      date_range: args.date_range,
    };
  }),
});

// ---------------------------------------------------------------------------
// 12. org_utilisation — finmgr/admin only
// ---------------------------------------------------------------------------
export const orgUtilisationTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'org_utilisation',
  description: 'Org-wide utilisation: total hours logged vs configured capacity. Admin/FinMgr only.',
  parameters: z.object({ date_range: DateRange }),
  execute: async (input) => safe(async () => {
    const okAdmin = await rbac.canActAsRole(requesterId, 'admin');
    const okFin = await rbac.canActAsRole(requesterId, 'finmgr');
    if (!okAdmin && !okFin) throw new RbacForbiddenError();
    const args = input as { date_range: { from: string; to: string } };
    const rows = await prisma.$queryRawUnsafe<Array<{ total_hours: unknown; billable_hours: unknown }>>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS total_hours,
              COALESCE(SUM(CASE WHEN billable THEN EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0 ELSE 0 END), 0) AS billable_hours
       FROM time_entries
       WHERE end_at IS NOT NULL
         AND start_at >= $1::date
         AND start_at < ($2::date + INTERVAL '1 day')`,
      args.date_range.from,
      args.date_range.to,
    );
    return {
      total_hours: Number(rows[0]?.total_hours ?? 0),
      billable_hours: Number(rows[0]?.billable_hours ?? 0),
      date_range: args.date_range,
    };
  }),
});

// ---------------------------------------------------------------------------
// 13. who_is_clocked_in — manager-scoped count only (no individual names)
// ---------------------------------------------------------------------------
export const whoIsClockedInTool: ChatbotToolFactory = (requesterId, prisma, rbac) => ({
  name: 'who_is_clocked_in',
  description: 'How many of the requester\'s scoped team are currently clocked in. Returns count only — never names.',
  parameters: z.object({}),
  execute: async () => safe(async () => {
    const isManager = await rbac.canActAsRole(requesterId, 'manager') || await rbac.canActAsRole(requesterId, 'admin') || await rbac.canActAsRole(requesterId, 'finmgr');
    if (!isManager) throw new RbacForbiddenError();
    const visibleUsers = await rbac.getVisibleUserIds(requesterId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const rows = await prisma.$queryRawUnsafe<Array<{ running_count: unknown }>>(
      `SELECT COUNT(*)::int AS running_count
       FROM time_entries
       WHERE status = 'running'
         ${userIds ? `AND user_id = ANY($1::bigint[])` : ''}`,
      ...(userIds ? [userIds] : []),
    );
    return { running_count: Number(rows[0]?.running_count ?? 0) };
  }),
});

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------
export function buildChatbotTools(
  requesterId: string,
  prisma: ChatbotPrismaLike,
  rbac: RbacScopeService,
): Record<string, ToolDef> {
  const factories: ChatbotToolFactory[] = [
    getUserHoursTool,
    listMyProjectsTool,
    projectRollupTool,
    listExceptionsTool,
    teamSummaryTool,
    topBillableProjectsTool,
    findUserByNameTool,
    findProjectByNameTool,
    getUserScheduleTool,
    listOvertimeTool,
    moodTrendTool,
    orgUtilisationTool,
    whoIsClockedInTool,
  ];
  const out: Record<string, ToolDef> = {};
  for (const f of factories) {
    const tool = f(requesterId, prisma, rbac);
    out[tool.name] = tool;
  }
  return out;
}
