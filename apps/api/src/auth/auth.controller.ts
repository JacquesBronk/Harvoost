import { Body, Controller, Get, Inject, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './public.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { OIDCFailureError } from '@harvoost/shared';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { z } from 'zod';
import { OidcService } from './oidc.service';

// Provider-agnostic OIDC flow (ADR-0001):
//   1. POST /v1/auth/oidc/login  { client_kind?: 'web'|'tray' }
//      -> { authorization_url, opaque_state_id }
//      The opaque_state_id is the row id of an auth_pending row holding the
//      server-side state/nonce/code_verifier. The frontend redirects the
//      browser to authorization_url; the IdP redirects back with ?code&state.
//   2. POST /v1/auth/oidc/callback { code, state, opaque_state_id }
//      -> { session_token, expires_at, user }
//      Looks up auth_pending, validates state matches, exchanges code for
//      tokens, validates id_token against the JWKS, upserts user, mints a
//      Harvoost session, sets HttpOnly cookie, deletes auth_pending row.

const LoginInitSchema = z.object({
  client_kind: z.enum(['web', 'tray']).optional().default('web'),
});

const OidcCallbackSchema = z.object({
  code: z.string().min(1).max(8192),
  state: z.string().min(1).max(512),
  opaque_state_id: z.string().uuid(),
});

const SESSION_COOKIE_NAME = 'harvoost_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;
const AUTH_PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

// Best-effort human-friendly name derived from an issuer URL's host, used only
// when OIDC_DISPLAY_NAME is unset. e.g.
//   https://login.microsoftonline.com/<tenant>/v2.0 -> "login.microsoftonline.com"
//   http://localhost:8080/realms/harvoost            -> "localhost"
// Returns undefined when the issuer cannot be parsed (caller falls back to the
// literal "your identity provider").
function deriveDisplayNameFromIssuer(issuer: string): string | undefined {
  try {
    const host = new URL(issuer).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

@Throttle({ auth: { ttl: 60_000, limit: 5 } })
@Controller('v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly oidc: OidcService,
  ) {}

  // PUBLIC, unauthenticated GET — must be reachable on the pre-login page so the
  // web app can render provider-agnostic copy ("Continue with <display_name>")
  // and surface the issuer for transparency. No auth guard, no CSRF requirement.
  //
  // display_name resolution (provider-agnostic, ADR-0001):
  //   1. env.OIDC_DISPLAY_NAME (authoritative — the discovery doc has no
  //      human-friendly name).
  //   2. else a name derived from the discovery issuer host.
  //   3. else the literal "your identity provider".
  // issuer comes from the cached discovery doc; if discovery is momentarily
  // unreachable we fall back to the configured OIDC_ISSUER_URL so the login
  // page still renders (idp-info must NOT fail just because the IdP is down).
  @Public()
  @Get('idp-info')
  async idpInfo(): Promise<{ display_name: string; issuer: string }> {
    let issuer = this.env.OIDC_ISSUER_URL;
    try {
      const disc = await this.oidc.getDiscovery();
      if (disc.issuer) {
        issuer = disc.issuer;
      }
    } catch (err) {
      // Graceful degradation: keep the configured issuer URL as the fallback.
      this.logger.warn(
        `idp-info: discovery unreachable, falling back to OIDC_ISSUER_URL (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    const displayName =
      this.env.OIDC_DISPLAY_NAME?.trim() ||
      deriveDisplayNameFromIssuer(issuer) ||
      'your identity provider';

    return { display_name: displayName, issuer };
  }

  @Public()
  @Post('oidc/login')
  async oidcLogin(
    @Body(new ZodValidationPipe(LoginInitSchema)) body: z.infer<typeof LoginInitSchema>,
  ): Promise<{ authorization_url: string; opaque_state_id: string }> {
    const clientKind = body.client_kind ?? 'web';
    const redirectUri =
      clientKind === 'tray' ? this.env.OIDC_REDIRECT_URI_TRAY : this.env.OIDC_REDIRECT_URI_WEB;
    const state = OidcService.generateState();
    const nonce = OidcService.generateNonce();
    const { codeVerifier, codeChallenge } = OidcService.generatePkcePair();

    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `INSERT INTO auth_pending (state, nonce, code_verifier, client_kind, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * INTERVAL '1 millisecond'))
       RETURNING id`,
      state,
      nonce,
      codeVerifier,
      clientKind,
      redirectUri,
      AUTH_PENDING_TTL_MS,
    );
    const opaqueStateId = String(inserted[0]!.id);

    const authorizationUrl = await this.oidc.getAuthorizationUrl({
      state,
      nonce,
      codeChallenge,
      redirectUri,
    });

    return { authorization_url: authorizationUrl, opaque_state_id: opaqueStateId };
  }

  @Public()
  @Post('oidc/callback')
  async oidcCallback(
    @Body(new ZodValidationPipe(OidcCallbackSchema)) body: z.infer<typeof OidcCallbackSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    session_token: string;
    expires_at: string;
    user: { id: string; email: string; roles: string[] };
  }> {
    // 1. Look up the auth_pending row by opaque_state_id; verify state matches and not expired.
    const pendingRows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: unknown;
        state: unknown;
        nonce: unknown;
        code_verifier: unknown;
        client_kind: unknown;
        redirect_uri: unknown;
        expires_at: unknown;
      }>
    >(
      `SELECT id, state, nonce, code_verifier, client_kind, redirect_uri, expires_at
       FROM auth_pending
       WHERE id = $1::uuid
       LIMIT 1`,
      body.opaque_state_id,
    );
    if (pendingRows.length === 0) {
      throw new OIDCFailureError('OIDC pending-state not found.');
    }
    const pending = pendingRows[0]!;
    if (new Date(String(pending.expires_at)) < new Date()) {
      // Clean up and refuse.
      await this.prisma
        .$executeRawUnsafe(`DELETE FROM auth_pending WHERE id = $1::uuid`, body.opaque_state_id)
        .catch(() => undefined);
      throw new OIDCFailureError('OIDC pending-state expired.');
    }
    if (String(pending.state) !== body.state) {
      throw new OIDCFailureError('OIDC state mismatch.');
    }
    const codeVerifier = String(pending.code_verifier);
    const nonce = String(pending.nonce);
    const redirectUri = String(pending.redirect_uri);

    // 2. Exchange the code for tokens.
    const tokens = await this.oidc.exchangeCodeForToken({
      code: body.code,
      codeVerifier,
      redirectUri,
    });

    // 3. Validate the id_token. Throws on any failure (signature, aud, iss, exp, nbf, nonce).
    const claims = await this.oidc.validateIdToken(tokens.idToken, nonce);

    if (!claims.email) {
      throw new OIDCFailureError('id_token missing email claim (required by Harvoost).');
    }

    // 4. Upsert user by `sub` (canonical OIDC identifier; stored in users.entra_object_id
    //    for now — column is semantically "oidc_subject"; rename deferred to a later migration).
    let userId: string;
    const bySub = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `SELECT id FROM users WHERE entra_object_id = $1 LIMIT 1`,
      claims.sub,
    );
    if (bySub.length > 0) {
      userId = String(bySub[0]!.id);
      // Update email/display_name if they changed at the IdP.
      await this.prisma.$executeRawUnsafe(
        `UPDATE users SET email = $1, display_name = COALESCE($2, display_name), updated_at = NOW()
         WHERE id = $3::bigint`,
        claims.email,
        claims.name ?? null,
        userId,
      );
    } else {
      // Migration fallback: try to find an existing user by email (e.g., legacy mock-OIDC rows
      // whose entra_object_id was 'mock-<email>'). Rewrite their entra_object_id to the real sub.
      const byEmail = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        claims.email,
      );
      if (byEmail.length > 0) {
        userId = String(byEmail[0]!.id);
        await this.prisma.$executeRawUnsafe(
          `UPDATE users SET entra_object_id = $1, display_name = COALESCE($2, display_name), updated_at = NOW()
           WHERE id = $3::bigint`,
          claims.sub,
          claims.name ?? null,
          userId,
        );
      } else {
        // Truly new user — provision with role from admin_email_allowlist or BOOTSTRAP_ADMIN_EMAIL match.
        const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
          `INSERT INTO users (entra_object_id, email, display_name, timezone, is_active)
           VALUES ($1, $2, $3, 'Africa/Johannesburg', TRUE)
           RETURNING id`,
          claims.sub,
          claims.email,
          claims.name ?? claims.email,
        );
        userId = String(inserted[0]!.id);
        const allowlistMatch = await this.prisma.$queryRawUnsafe<Array<{ c: unknown }>>(
          `SELECT 1 AS c FROM admin_email_allowlist WHERE LOWER(email) = LOWER($1) LIMIT 1`,
          claims.email,
        );
        const isAdmin =
          allowlistMatch.length > 0 ||
          claims.email.toLowerCase() === this.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
        const role = isAdmin ? 'admin' : 'employee';
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO user_roles (user_id, role) VALUES ($1::bigint, $2)
           ON CONFLICT (user_id, role) DO NOTHING`,
          userId,
          role,
        );
      }
    }

    // 5. Mint Harvoost session (opaque 32-byte base64url).
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const kind = String(pending.client_kind) === 'tray' ? 'tray' : 'web';
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO sessions (user_id, kind, expires_at, refresh_token_hash, user_agent, ip)
       VALUES ($1::bigint, $2, $3::timestamptz, encode(digest($4::text, 'sha256'), 'hex'), $5, $6)`,
      userId,
      kind,
      expiresAt.toISOString(),
      sessionToken,
      req.headers['user-agent'] ?? '',
      req.ip ?? '',
    );

    // 6. Set HttpOnly cookie (web clients use this; tray reads session_token from the body).
    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    // 7. Delete the auth_pending row — single-use.
    await this.prisma
      .$executeRawUnsafe(`DELETE FROM auth_pending WHERE id = $1::uuid`, body.opaque_state_id)
      .catch(() => undefined);

    const roleRows = await this.prisma.$queryRawUnsafe<Array<{ role: unknown }>>(
      `SELECT role FROM user_roles WHERE user_id = $1::bigint`,
      userId,
    );
    return {
      session_token: sessionToken,
      expires_at: expiresAt.toISOString(),
      user: {
        id: userId,
        email: claims.email,
        roles: roleRows.map((r) => String(r.role)),
      },
    };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const header = req.headers.authorization;
    const reqWithCookies = req as Request & { cookies?: Record<string, string> };
    const cookieToken = reqWithCookies.cookies?.[SESSION_COOKIE_NAME];
    let token: string | undefined;
    if (header?.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim();
    } else if (cookieToken) {
      token = cookieToken;
    }
    if (token) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE refresh_token_hash = encode(digest($1::text, 'sha256'), 'hex')`,
        token,
      );
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  // Current user. The bearer guard has already populated `user` (id, email,
  // roles) from the session, but it does NOT carry display_name — so we load it
  // from the users row here. display_name is NOT NULL in the schema, but we fall
  // back to email defensively so the contract is `display_name: string` (never
  // null/undefined); that keeps the web shell simple (it renders display_name
  // directly without a null guard).
  @Get('me')
  async me(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ id: string; email: string; display_name: string; roles: string[] }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ display_name: unknown }>>(
      `SELECT display_name FROM users WHERE id = $1::bigint LIMIT 1`,
      user.userId,
    );
    const rawDisplayName = rows[0]?.display_name;
    const displayName =
      typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0
        ? rawDisplayName
        : user.email;
    return { id: user.userId, email: user.email, display_name: displayName, roles: user.roles };
  }
}
