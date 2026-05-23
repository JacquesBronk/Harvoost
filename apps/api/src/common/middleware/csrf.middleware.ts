import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_COOKIE_NAME = 'harvoost_session';

// Finding 8 — CSRF protection for state-changing routes.
//
// Strategy (v1):
//   1. SAFE methods (GET/HEAD/OPTIONS) — pass through (no state change).
//   2. Authorization: Bearer header present — pass through. The tray client uses
//      bearer-in-keytar, not browser-issued cookies; CORS preflight + the inability
//      of a cross-origin browser to forge an Authorization header makes this safe.
//   3. Cookie-authenticated browser requests — require either an `Origin` header
//      whose value is in CORS_ALLOWED_ORIGINS, OR an `X-Requested-With: XMLHttpRequest`
//      header (browsers will not send this cross-origin without a CORS preflight).
//   4. Otherwise -> 403 CSRF_FAILURE.
//
// SameSite=Lax on the session cookie (set by AuthController) is the second layer.
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);
  private readonly allowedOrigins: Set<string>;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.allowedOrigins = new Set(
      env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    );
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return next();
    }

    // Bearer-authenticated (tray) — exempt. The token is never set by a browser cookie.
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return next();
    }

    // Cookie-authenticated browser request.
    const reqWithCookies = req as Request & { cookies?: Record<string, string> };
    const hasSessionCookie = Boolean(reqWithCookies.cookies?.[SESSION_COOKIE_NAME]);
    if (!hasSessionCookie) {
      // No credentials at all — let the auth guard reject with 401.
      return next();
    }

    const origin = req.headers.origin;
    const requestedWith = req.headers['x-requested-with'];

    const originOk = typeof origin === 'string' && this.allowedOrigins.has(origin);
    const xrwOk = typeof requestedWith === 'string' && requestedWith.toLowerCase() === 'xmlhttprequest';

    if (originOk || xrwOk) {
      return next();
    }

    this.logger.warn('csrf.reject', {
      method: req.method,
      path: req.path,
      origin: origin ?? null,
      hasXrw: Boolean(requestedWith),
    });
    res.status(403).json({
      code: 'CSRF_FAILURE',
      message: 'Cross-site request rejected. Provide a matching Origin header or X-Requested-With: XMLHttpRequest.',
    });
  }
}
