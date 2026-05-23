import { SetMetadata } from '@nestjs/common';
import type { Role } from '@harvoost/shared';

export const ROLES_KEY = 'harvoost.roles';

// Decorator placed on a controller or route to declare required roles.
// The RolesGuard reads this and 403s if the requester lacks all of them.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
