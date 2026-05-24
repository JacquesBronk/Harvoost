import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';
import { OIDCFailureError } from '@harvoost/shared';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

// Provider-agnostic OIDC client (ADR-0001). Speaks plain OIDC discovery + JWKS.
// Works against Entra (prod) and Keycloak (dev) — the only thing that varies is
// env.OIDC_ISSUER_URL.

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  response_types_supported?: string[];
  // Other fields are present per OIDC spec; we only consume what we need.
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
}

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  private cachedDiscovery: DiscoveryDocument | null = null;
  private cachedAt = 0;
  private cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private cachedJwksUri: string | null = null;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  // PKCE — RFC 7636 §4.2.
  static generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  static generateState(): string {
    return randomBytes(24).toString('base64url');
  }

  static generateNonce(): string {
    return randomBytes(24).toString('base64url');
  }

  async getDiscovery(): Promise<DiscoveryDocument> {
    const now = Date.now();
    if (this.cachedDiscovery && now - this.cachedAt < DISCOVERY_TTL_MS) {
      return this.cachedDiscovery;
    }
    const url = `${this.env.OIDC_ISSUER_URL.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OIDCFailureError(
        `OIDC discovery fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new OIDCFailureError(`OIDC discovery returned ${res.status} from ${url}`);
    }
    const doc = (await res.json()) as DiscoveryDocument;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new OIDCFailureError('OIDC discovery missing required fields.');
    }
    this.cachedDiscovery = doc;
    this.cachedAt = now;
    // Rebuild JWKS if the jwks_uri changed (or first time).
    if (this.cachedJwksUri !== doc.jwks_uri) {
      this.cachedJwks = createRemoteJWKSet(new URL(doc.jwks_uri), {
        cooldownDuration: 30_000,
      });
      this.cachedJwksUri = doc.jwks_uri;
    }
    return doc;
  }

  // Returns { authorizationUrl } for the user to be redirected to.
  async getAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
    scope?: string;
  }): Promise<string> {
    const disc = await this.getDiscovery();
    const url = new URL(disc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.env.OIDC_CLIENT_ID);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', params.scope ?? 'openid email profile');
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  // Exchange authorization code for tokens. Returns the raw id_token (string).
  async exchangeCodeForToken(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ idToken: string; accessToken?: string; refreshToken?: string }> {
    const disc = await this.getDiscovery();
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', params.code);
    body.set('redirect_uri', params.redirectUri);
    body.set('client_id', this.env.OIDC_CLIENT_ID);
    body.set('code_verifier', params.codeVerifier);
    if (this.env.OIDC_CLIENT_SECRET) {
      body.set('client_secret', this.env.OIDC_CLIENT_SECRET);
    }
    let res: Response;
    try {
      res = await fetch(disc.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OIDCFailureError(
        `OIDC token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      // Don't bubble the IdP's body to the client — it may contain trace IDs etc.
      const text = await res.text().catch(() => '');
      this.logger.warn('oidc.token_exchange.non_2xx', { status: res.status, body: text.slice(0, 500) });
      throw new OIDCFailureError(`OIDC token exchange returned ${res.status}`);
    }
    const json = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };
    if (!json.id_token) {
      throw new OIDCFailureError('OIDC token response missing id_token.');
    }
    const result: { idToken: string; accessToken?: string; refreshToken?: string } = {
      idToken: json.id_token,
    };
    if (json.access_token) result.accessToken = json.access_token;
    if (json.refresh_token) result.refreshToken = json.refresh_token;
    return result;
  }

  // RP-initiated logout (OIDC RP-Initiated Logout 1.0) — provider-agnostic.
  // Builds the IdP end-session URL from the SAME discovery doc used for login, so
  // it works for Keycloak (dev) and Microsoft Entra (prod) without any
  // provider-specific paths or params (ADR-0001).
  //
  // Returns null — never throws — when:
  //   - the discovery doc has no `end_session_endpoint` (some IdPs omit it), or
  //   - discovery is momentarily unreachable.
  // The caller (logout) then falls back to a local-only logout. Local session
  // teardown must never be blocked by an IdP URL we couldn't build.
  //
  // INC-008 / CWE-601: `postLogoutRedirectUri` MUST be built by the caller from
  // trusted config only (WEB_ORIGIN + /login) — never from request input.
  async buildEndSessionUrl(params: {
    postLogoutRedirectUri: string;
    logoutHint?: string;
  }): Promise<string | null> {
    let endSessionEndpoint: string | undefined;
    try {
      const disc = await this.getDiscovery();
      endSessionEndpoint = disc.end_session_endpoint;
    } catch (err) {
      this.logger.warn(
        `buildEndSessionUrl: discovery unreachable, falling back to local logout (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
    if (!endSessionEndpoint) {
      return null;
    }
    const url = new URL(endSessionEndpoint);
    url.searchParams.set('client_id', this.env.OIDC_CLIENT_ID);
    url.searchParams.set('post_logout_redirect_uri', params.postLogoutRedirectUri);
    if (params.logoutHint) {
      url.searchParams.set('logout_hint', params.logoutHint);
    }
    return url.toString();
  }

  // Validate id_token signature + claims. Returns the canonical { sub, email, name }.
  async validateIdToken(idToken: string, expectedNonce: string): Promise<OidcClaims> {
    const disc = await this.getDiscovery();
    if (!this.cachedJwks) {
      // Lazy build (defensive — getDiscovery sets this, but if called out of order).
      this.cachedJwks = createRemoteJWKSet(new URL(disc.jwks_uri), {
        cooldownDuration: 30_000,
      });
      this.cachedJwksUri = disc.jwks_uri;
    }
    let result: JWTVerifyResult;
    try {
      result = await jwtVerify(idToken, this.cachedJwks, {
        issuer: disc.issuer,
        audience: this.env.OIDC_CLIENT_ID,
      });
    } catch (err) {
      throw new OIDCFailureError(
        `id_token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const payload = result.payload as JWTPayload & {
      nonce?: string;
      email?: string;
      name?: string;
      preferred_username?: string;
    };
    if (!payload.sub) {
      throw new OIDCFailureError('id_token missing sub claim.');
    }
    if (payload.nonce !== expectedNonce) {
      throw new OIDCFailureError('id_token nonce mismatch.');
    }
    // exp/nbf are enforced inside jwtVerify; we still defend on missing exp.
    if (!payload.exp) {
      throw new OIDCFailureError('id_token missing exp claim.');
    }
    const claims: OidcClaims = { sub: payload.sub };
    if (payload.email) claims.email = payload.email;
    const displayName = payload.name ?? payload.preferred_username;
    if (displayName) claims.name = displayName;
    if (payload.preferred_username) claims.preferredUsername = payload.preferred_username;
    return claims;
  }
}
