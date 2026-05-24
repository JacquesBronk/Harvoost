"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RbacScopeService = void 0;
const errors_js_1 = require("./errors.js");
function assertRequester(requesterId) {
    if (requesterId === null || requesterId === undefined || requesterId === '') {
        throw new errors_js_1.RbacError('requesterId is required');
    }
    // we deliberately do not regex-validate — the type is just "non-empty string".
}
function toId(row, key) {
    const v = row[key];
    if (v === null || v === undefined) {
        throw new errors_js_1.RbacError(`expected ${key} in row, got ${typeof v}`);
    }
    // PG bigint comes back as string from $queryRaw; numeric ids come back as number.
    if (typeof v === 'bigint')
        return v.toString();
    return String(v);
}
// RbacScopeService — single source of truth for the cascading manager visibility rule.
//
// Per REQUIREMENTS.md § Cascading manager visibility:
//   visibleUsers(M) = UNION of
//     - project_anchored: users on projects where M is project_manager
//     - person_anchored:  users where M is in user_managers as manager
//     - {M itself}
//   visibleProjects(M) = UNION of
//     - project_anchored: projects where M is project_manager
//     - person_anchored:  projects of users M directly manages
//     - self_anchored:    projects M is a MEMBER of      (FEAT-002 expansion, issue #6)
//
// For Admin and FinMgr roles, the scope is unrestricted — see canActAsRole + special path.
//
// This implementation uses raw parameterized SQL — every parameter is bound,
// never string-interpolated.
class RbacScopeService {
    constructor(deps) {
        this.prisma = deps.prisma;
        if (deps.logger) {
            this.logger = deps.logger;
        }
    }
    async getVisibleUserIds(requesterId) {
        assertRequester(requesterId);
        if (await this.canActAsRole(requesterId, 'admin') || await this.canActAsRole(requesterId, 'finmgr')) {
            // Unrestricted — return the full set of active user ids.
            const rows = await this.prisma.$queryRawUnsafe(`SELECT id AS user_id FROM users WHERE is_active = TRUE`);
            return {
                userIds: rows.map((r) => toId(r, 'user_id')),
                meta: { fromProjects: 0, fromPersons: 0 },
                unrestricted: true,
            };
        }
        // Manager / employee — apply the UNION cascade.
        const sql = `
      WITH project_anchored AS (
        SELECT DISTINCT pm.user_id, pgm.project_id AS via_project
        FROM project_managers pgm
        JOIN project_members pm ON pm.project_id = pgm.project_id
        WHERE pgm.manager_id = $1::bigint
          AND pm.left_at IS NULL
      ),
      person_anchored AS (
        SELECT um.user_id, NULL::bigint AS via_project
        FROM user_managers um
        WHERE um.manager_id = $1::bigint
      ),
      combined AS (
        SELECT user_id, via_project FROM project_anchored
        UNION
        SELECT user_id, via_project FROM person_anchored
        UNION
        SELECT $1::bigint AS user_id, NULL::bigint AS via_project
      )
      SELECT user_id,
             (SELECT COUNT(DISTINCT via_project) FROM combined WHERE via_project IS NOT NULL) AS from_projects,
             (SELECT COUNT(*) FROM person_anchored) AS from_persons
      FROM combined`;
        const rows = await this.prisma.$queryRawUnsafe(sql, requesterId);
        const userIds = Array.from(new Set(rows.map((r) => toId(r, 'user_id'))));
        const fromProjects = rows.length > 0 ? Number(rows[0].from_projects ?? 0) : 0;
        const fromPersons = rows.length > 0 ? Number(rows[0].from_persons ?? 0) : 0;
        return {
            userIds,
            meta: { fromProjects, fromPersons },
            unrestricted: false,
        };
    }
    async getVisibleProjectIds(requesterId) {
        assertRequester(requesterId);
        if (await this.canActAsRole(requesterId, 'admin') || await this.canActAsRole(requesterId, 'finmgr')) {
            const rows = await this.prisma.$queryRawUnsafe(`SELECT id AS project_id FROM projects WHERE is_active = TRUE`);
            return {
                projectIds: rows.map((r) => toId(r, 'project_id')),
                meta: { fromProjects: 0, fromPersons: 0 },
                unrestricted: true,
            };
        }
        // FEAT-002 (issue #6): self_anchored adds the caller's OWN member-projects (person-anchored
        // to the viewer themselves) so a plain employee — who manages nothing — still sees the projects
        // they belong to. Bounded strictly to the caller's own project_members rows (left_at IS NULL);
        // it does not transit to other users. The from_projects/from_persons meta stay manager-anchored
        // (unchanged) so existing meta assertions don't regress; self-membership is not counted there.
        const sql = `
      WITH project_anchored AS (
        SELECT pgm.project_id
        FROM project_managers pgm
        WHERE pgm.manager_id = $1::bigint
      ),
      person_anchored AS (
        SELECT DISTINCT pm.project_id, um.user_id AS via_user
        FROM user_managers um
        JOIN project_members pm ON pm.user_id = um.user_id
        WHERE um.manager_id = $1::bigint
          AND pm.left_at IS NULL
      ),
      self_anchored AS (
        SELECT pm.project_id
        FROM project_members pm
        WHERE pm.user_id = $1::bigint
          AND pm.left_at IS NULL
      ),
      combined AS (
        SELECT project_id, NULL::bigint AS via_user FROM project_anchored
        UNION
        SELECT project_id, via_user FROM person_anchored
        UNION
        SELECT project_id, NULL::bigint AS via_user FROM self_anchored
      )
      SELECT project_id,
             (SELECT COUNT(*) FROM project_anchored) AS from_projects,
             (SELECT COUNT(DISTINCT via_user) FROM person_anchored WHERE via_user IS NOT NULL) AS from_persons
      FROM combined`;
        const rows = await this.prisma.$queryRawUnsafe(sql, requesterId);
        const projectIds = Array.from(new Set(rows.map((r) => toId(r, 'project_id'))));
        const fromProjects = rows.length > 0 ? Number(rows[0].from_projects ?? 0) : 0;
        const fromPersons = rows.length > 0 ? Number(rows[0].from_persons ?? 0) : 0;
        return {
            projectIds,
            meta: { fromProjects, fromPersons },
            unrestricted: false,
        };
    }
    async canActAsRole(userId, role) {
        assertRequester(userId);
        const rows = await this.prisma.userRole.findMany({ where: { userId } });
        return rows.some((r) => r.role === role);
    }
    // Sanctioned escape hatch for queries that should hit ONLY the requester's own rows
    // (e.g., mood entries, own time entries during clock-in flow). Documented separately
    // so the ESLint rule can whitelist it.
    withSelfScope(userId) {
        assertRequester(userId);
        return { userIds: [userId], selfOnly: true };
    }
    // Convenience: throw 403 if requester cannot see a specific target user.
    async assertCanSeeUser(requesterId, targetUserId) {
        const scope = await this.getVisibleUserIds(requesterId);
        if (scope.unrestricted)
            return;
        if (!scope.userIds.includes(targetUserId)) {
            this.logger?.warn('rbac.deny.user', { requesterId, targetUserId });
            throw new errors_js_1.RbacForbiddenError();
        }
    }
    async assertCanSeeProject(requesterId, projectId) {
        const scope = await this.getVisibleProjectIds(requesterId);
        if (scope.unrestricted)
            return;
        if (!scope.projectIds.includes(projectId)) {
            this.logger?.warn('rbac.deny.project', { requesterId, projectId });
            throw new errors_js_1.RbacForbiddenError();
        }
    }
}
exports.RbacScopeService = RbacScopeService;
//# sourceMappingURL=RbacScopeService.js.map