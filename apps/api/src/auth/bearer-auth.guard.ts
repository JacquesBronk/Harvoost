import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

// Routes can opt out via @Public(). Health check + OIDC entry/callback endpoints use this.
export const PUBLIC_KEY = 'harvoost.public';

const SESSION_COOKIE_NAME = 'harvoost_session';

// Validates the session against the sessions table. Accepts either:
//   - Authorization: Bearer <token>     (tray, also valid for web)
//   - Cookie: harvoost_session=<token>  (web)
//
// In NODE_ENV=test with TEST_AUTH_BYPASS=1 (env invariant refuses this combo in
// any other env), the guard also accepts X-Test-User-Id and looks up the matching
// session (test helpers mint these via mintTestSession()).
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown; cookies?: Record<string, string> }>();
    const header = req.headers.authorization;

    // TEST-only bypass — exists strictly to let unit/integration tests avoid the
    // full OIDC handshake. Guarded by NODE_ENV=test AND TEST_AUTH_BYPASS=1; the
    // env loader refuses TEST_AUTH_BYPASS=1 outside NODE_ENV=test.
    if (this.env.TEST_AUTH_BYPASS && this.env.NODE_ENV === 'test') {
      const testUserId = req.headers['x-test-user-id'];
      if (typeof testUserId === 'string' && testUserId.length > 0) {
        const user = await this.lookupUser(testUserId);
        if (user) {
          req.user = user;
          return true;
        }
      }
    }

    // Resolve session token from Bearer header or HttpOnly cookie.
    let token: string | undefined;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim();
    }
    if (!token) {
      const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
      if (cookieToken && cookieToken.length > 0) {
        token = cookieToken;
      }
    }
    if (!token || token.length === 0) {
      throw new UnauthorizedException('Missing session credential (Bearer header or session cookie).');
    }

    // Look up the session by hash.
    let sessions: Array<{ user_id: unknown; expires_at: unknown }> = [];
    try {
      sessions = await this.prisma.$queryRawUnsafe<Array<{ user_id: unknown; expires_at: unknown }>>(
        `SELECT user_id, expires_at FROM sessions
         WHERE refresh_token_hash = encode(digest($1::text, 'sha256'), 'hex')
           AND revoked_at IS NULL
         LIMIT 1`,
        token,
      );
    } catch {
      // DB unavailable or session schema not yet present — block.
      throw new UnauthorizedException('Session validation failed');
    }
    if (sessions.length === 0) {
      throw new UnauthorizedException('Invalid or revoked session');
    }
    const session = sessions[0]!;
    if (new Date(String(session.expires_at)) < new Date()) {
      throw new UnauthorizedException('Session expired');
    }
    const user = await this.lookupUser(String(session.user_id));
    if (!user) throw new UnauthorizedException('User not found or inactive');
    req.user = user;
    return true;
  }

  private async lookupUser(userId: string): Promise<{ userId: string; email: string; roles: string[] } | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ email: unknown; role: unknown }>>(
        `SELECT u.email, ur.role
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         WHERE u.id = $1::bigint AND u.is_active = TRUE`,
        userId,
      );
      if (rows.length === 0) return null;
      const email = String(rows[0]!.email);
      const roles = rows.filter((r) => r.role !== null && r.role !== undefined).map((r) => String(r.role));
      return { userId, email, roles };
    } catch {
      return null;
    }
  }
}
