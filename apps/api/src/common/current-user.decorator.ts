import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CurrentUserPayload {
  userId: string;
  email: string;
  roles: string[];
}

// Extracts the auth-guard-populated user from the request.
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
  const req = ctx.switchToHttp().getRequest<{ user?: CurrentUserPayload }>();
  if (!req.user) {
    throw new Error('CurrentUser called without an AuthGuard upstream — wire BearerAuthGuard.');
  }
  return req.user;
});
