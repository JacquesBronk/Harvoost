import type { ProjectId, ProjectIdScope, Role, UserId, UserIdScope } from './types.js';
export interface RbacPrismaLike {
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
    userRole: {
        findMany(args: {
            where: {
                userId: bigint | string | number;
            };
        }): Promise<Array<{
            role: string;
        }>>;
    };
}
export interface RbacScopeServiceDeps {
    prisma: RbacPrismaLike;
    logger?: {
        warn(msg: string, meta?: Record<string, unknown>): void;
    };
}
export declare class RbacScopeService {
    private readonly prisma;
    private readonly logger?;
    constructor(deps: RbacScopeServiceDeps);
    getVisibleUserIds(requesterId: UserId): Promise<UserIdScope>;
    getVisibleProjectIds(requesterId: UserId): Promise<ProjectIdScope>;
    canActAsRole(userId: UserId, role: Role): Promise<boolean>;
    withSelfScope(userId: UserId): {
        userIds: UserId[];
        selfOnly: true;
    };
    assertCanSeeUser(requesterId: UserId, targetUserId: UserId): Promise<void>;
    assertCanSeeProject(requesterId: UserId, projectId: ProjectId): Promise<void>;
}
//# sourceMappingURL=RbacScopeService.d.ts.map