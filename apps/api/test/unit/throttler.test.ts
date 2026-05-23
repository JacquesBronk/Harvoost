import { describe, it, expect } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import { ChatbotController } from '../../src/chatbot/chatbot.controller';

// Finding 4 — Throttle decorators applied to AuthController and ChatbotController.postMessage.
//
// @nestjs/throttler v6 stores per-name limits in SEPARATE metadata keys:
//   `THROTTLER:LIMIT:<name>` -> number
//   `THROTTLER:TTL:<name>`   -> number
// (one pair per named limiter). The decorator does NOT store a single object
// under one key. This test reads those keys directly to confirm the decorator
// is applied at the expected target with the expected name + values.

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';
// @nestjs/throttler v6 stores @SkipThrottle({ <name>: true }) under
// `THROTTLER:SKIP<name>` -> true (same "<KEY><name>", no separator, shape as
// the LIMIT/TTL keys). The guard reads it per named bucket via
// reflector.getAllAndOverride(`THROTTLER:SKIP<name>`, [handler, classRef]) and,
// when truthy, `continue`s past that bucket WITHOUT consulting its LIMIT/TTL —
// so a method-level SKIP fully overrides the class-level @Throttle for that one
// named bucket while leaving other buckets (e.g. `global`) in force.
const THROTTLER_SKIP = 'THROTTLER:SKIP';

function readNamedLimiter(target: object, name: string): { limit?: number; ttl?: number } {
  return {
    limit: Reflect.getMetadata(`${THROTTLER_LIMIT}${name}`, target) as number | undefined,
    ttl: Reflect.getMetadata(`${THROTTLER_TTL}${name}`, target) as number | undefined,
  };
}

function readNamedSkip(target: object, name: string): boolean | undefined {
  return Reflect.getMetadata(`${THROTTLER_SKIP}${name}`, target) as boolean | undefined;
}

describe('Throttle decorators — Finding 4', () => {
  it('AuthController class has the `auth` named limiter (5 req/min)', () => {
    // The @Throttle({ auth: { ttl: 60_000, limit: 5 } }) class decorator stores
    // metadata on the AuthController constructor itself. ThrottlerGuard reads
    // it at runtime to enforce per-route limits.
    const auth = readNamedLimiter(AuthController, 'auth');
    expect(auth.limit).toBe(5);
    expect(auth.ttl).toBe(60_000);
  });

  it('ChatbotController.postMessage is decorated with the `chatbot` named limiter (30 req/min)', () => {
    // Per-method decorators store metadata on the prototype method itself.
    const chatbot = readNamedLimiter(ChatbotController.prototype.postMessage, 'chatbot');
    expect(chatbot.limit).toBe(30);
    expect(chatbot.ttl).toBe(60_000);
  });

  it('ChatbotController.capabilities is NOT throttled by the chatbot limiter (read-only, allowed at global rate)', () => {
    // The class itself isn't decorated — only postMessage is. capabilities()
    // inherits no `chatbot` rate cap and falls through to the global limiter
    // (300/min). The absence of named-limiter metadata is the assertion.
    const chatbot = readNamedLimiter(ChatbotController.prototype.capabilities, 'chatbot');
    expect(chatbot.limit).toBeUndefined();
    expect(chatbot.ttl).toBeUndefined();
  });

  it('the AuthController limiter binds to a distinct name from chatbot (independent counters)', () => {
    // Auth target should have `auth` metadata but no `chatbot` metadata.
    const authOnAuth = readNamedLimiter(AuthController, 'auth');
    const chatbotOnAuth = readNamedLimiter(AuthController, 'chatbot');
    expect(authOnAuth.limit).toBe(5);
    expect(chatbotOnAuth.limit).toBeUndefined();

    // Chatbot postMessage should have `chatbot` metadata but no `auth` metadata.
    const authOnChatbot = readNamedLimiter(ChatbotController.prototype.postMessage, 'auth');
    const chatbotOnChatbot = readNamedLimiter(ChatbotController.prototype.postMessage, 'chatbot');
    expect(authOnChatbot.limit).toBeUndefined();
    expect(chatbotOnChatbot.limit).toBe(30);
  });
});

// INC-003 (issue #3) regression — GET /v1/auth/me must NOT sit on the 5/60s
// `auth` brute-force bucket, while oidc/login + oidc/callback MUST keep it.
//
// Live repro: an authenticated session hit /me on every page load/remount; the
// class-level @Throttle({ auth: { ttl: 60_000, limit: 5 } }) covered /me too, so
// the 5-token budget burned out in seconds and /me started returning
// 429 RATE_LIMITED, wedging the app. Fix: @SkipThrottle({ auth: true }) on me()
// only, so /me skips the `auth` bucket and falls back to the global 300/60s
// bucket — login/callback are untouched and stay at 5/60s.
//
// We assert at the decorator-metadata level (the established harness pattern;
// the runtime guard derives its behavior directly from this metadata via
// reflector.getAllAndOverride([handler, classRef]), so metadata == behavior).
describe('Throttle/SkipThrottle — INC-003 (/me off the auth brute-force bucket)', () => {
  it('me() carries @SkipThrottle({ auth: true }) so it skips the 5/60s `auth` bucket', () => {
    // Method-level SKIP for the `auth` bucket. The guard, iterating named
    // throttlers, sees getAllAndOverride(THROTTLER:SKIPauth, [me, AuthController])
    // === true for the `auth` bucket and `continue`s past it (never enforcing
    // 5/60s on /me). >5 rapid authenticated /me calls therefore cannot 429 on
    // the `auth` bucket.
    expect(readNamedSkip(AuthController.prototype.me, 'auth')).toBe(true);
  });

  it('me() does NOT skip the global bucket — /me still falls back to global 300/60s', () => {
    // Only the `auth` bucket is skipped; the `global` (and `default`) buckets
    // have no SKIP metadata on me(), so /me remains rate-limited at the global
    // 300/60s ceiling rather than being unbounded.
    expect(readNamedSkip(AuthController.prototype.me, 'global')).toBeUndefined();
    expect(readNamedSkip(AuthController.prototype.me, 'default')).toBeUndefined();
  });

  it('me() does NOT itself carry the `auth` limiter — the 5/60s cap lives only on the class', () => {
    // The 5/60s limit is class-level (for login/callback). me() must not
    // re-declare it; combined with the SKIP above, the `auth` bucket is fully
    // bypassed for /me.
    const authOnMe = readNamedLimiter(AuthController.prototype.me, 'auth');
    expect(authOnMe.limit).toBeUndefined();
    expect(authOnMe.ttl).toBeUndefined();
  });

  it('oidc/login + oidc/callback still inherit the class 5/60s `auth` bucket (brute-force intact)', () => {
    // These handlers must NOT be skipped: they have no SKIP:auth metadata, so
    // the guard enforces the class-level @Throttle({ auth: 5/60s }) on them.
    // The class still declares 5/60s, so login/callback 429 after 5 hits.
    expect(readNamedSkip(AuthController.prototype.oidcLogin, 'auth')).toBeUndefined();
    expect(readNamedSkip(AuthController.prototype.oidcCallback, 'auth')).toBeUndefined();

    const authOnClass = readNamedLimiter(AuthController, 'auth');
    expect(authOnClass.limit).toBe(5);
    expect(authOnClass.ttl).toBe(60_000);
  });
});
