import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacForbiddenError } from '@harvoost/shared';
import { ROLES_KEY } from '../common/roles.decorator';
import type { CurrentUserPayload } from '../common/current-user.decorator';
import type { Role } from '@harvoost/shared';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<{ user?: CurrentUserPayload }>();
    const user = req.user;
    if (!user) throw new RbacForbiddenError('Authentication required.');
    if (!user.roles.some((r) => required.includes(r as Role))) {
      throw new RbacForbiddenError(`Requires one of roles: ${required.join(', ')}`);
    }
    return true;
  }
}
