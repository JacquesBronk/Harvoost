import { Global, Module } from '@nestjs/common';
import { RbacScopeService } from '@harvoost/shared';
import { PrismaService } from '../prisma/prisma.service';

export const RBAC_SCOPE_SERVICE = 'RBAC_SCOPE_SERVICE';

@Global()
@Module({
  providers: [
    {
      provide: RBAC_SCOPE_SERVICE,
      useFactory: (prisma: PrismaService) =>
        new RbacScopeService({
          prisma: {
            $queryRawUnsafe: (sql, ...values) => prisma.$queryRawUnsafe(sql, ...values),
            userRole: {
              findMany: async ({ where }) => {
                // Hand-rolled to dodge a tight coupling to Prisma's generated types.
                const rows = await prisma.$queryRawUnsafe<Array<{ role: string }>>(
                  `SELECT role FROM user_roles WHERE user_id = $1::bigint`,
                  String(where.userId),
                );
                return rows;
              },
            },
          },
          logger: { warn: (msg, meta) => console.warn(msg, meta) },
        }),
      inject: [PrismaService],
    },
  ],
  exports: [RBAC_SCOPE_SERVICE],
})
export class RbacModule {}
