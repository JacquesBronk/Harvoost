import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import { PrincipalThrottlerGuard } from '../../src/common/throttler/principal-throttler.guard';
import { AuthController } from '../../src/auth/auth.controller';
import { ProjectsController } from '../../src/projects/projects.controller';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { ChatbotController } from '../../src/chatbot/chatbot.controller';

// INC-005 (issue #8) regression — the over-aggressive rate limit.
//
// Root cause (confirmed against @nestjs/throttler v6.5.0 source): every named
// bucket in ThrottlerModule.forRoot([...]) is enforced on EVERY route unless
// that route opts out, so the smallest bucket (`auth` 5/60s) capped all reads.
// Fix B + A1: PrincipalThrottlerGuard keys per principal AND makes `auth` /
// `chatbot` OPT-IN (a route is exempt unless it carries @Throttle for that
// bucket). `global` stays app-wide. These tests exercise the guard directly.

// The forRoot config the guard runs under (sorted by ttl by the base class; the
// values matter only insofar as `global` is the sole app-wide bucket).
const THROTTLERS = [
  { name: 'chatbot', ttl: 60_000, limit: 30 },
  { name: 'auth', ttl: 60_000, limit: 5 },
  { name: 'global', ttl: 60_000, limit: 1000 },
];

// A storage spy: handleRequest's "real" path calls storageService.increment.
// If the guard EXEMPTS a route from a bucket, increment is NEVER called for it
// — that is exactly the assertion that proves the opt-in/exempt behaviour.
function makeStorageSpy(): ThrottlerStorage & { increment: ReturnType<typeof vi.fn> } {
  const increment = vi.fn(async () => ({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  }));
  return { increment } as unknown as ThrottlerStorage & { increment: ReturnType<typeof vi.fn> };
}

// Build a guard instance + a captured storage spy. The base class reads
// this.throttlers in onModuleInit, so we call it to populate commonOptions.
async function makeGuard() {
  const reflector = new Reflector();
  const storage = makeStorageSpy();
  const guard = new PrincipalThrottlerGuard(THROTTLERS, storage, reflector);
  await guard.onModuleInit();
  return { guard, storage };
}

// Minimal ExecutionContext that points getHandler/getClass at the real
// controller method + class so the Reflector reads the actual @Throttle /
// @SkipThrottle metadata the decorators defined. getRequestResponse only needs
// a req with headers and a res with header()/no-op for the non-exempt path.
function makeContext(handler: (...args: unknown[]) => unknown, classRef: object): ExecutionContext {
  const req = { headers: {}, ip: '10.0.0.9', user: { userId: '42' } };
  const res = { header: () => undefined };
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

// Invoke the guard's protected handleRequest for a single named bucket against a
// given route. Returns the storage spy so the caller can assert increment was
// or was not called (called == bucket enforced; not called == route exempt).
async function runBucket(
  guard: PrincipalThrottlerGuard,
  storage: ThrottlerStorage & { increment: ReturnType<typeof vi.fn> },
  bucketName: string,
  handler: (...args: unknown[]) => unknown,
  classRef: object,
) {
  const throttler = THROTTLERS.find((t) => t.name === bucketName)!;
  const context = makeContext(handler, classRef);
  const props: ThrottlerRequest = {
    context,
    limit: throttler.limit,
    ttl: throttler.ttl,
    throttler,
    blockDuration: throttler.ttl,
    getTracker: (guard as unknown as { getTracker: ThrottlerRequest['getTracker'] }).getTracker.bind(guard),
    generateKey: (guard as unknown as { generateKey: ThrottlerRequest['generateKey'] }).generateKey.bind(guard),
  };
  // handleRequest is protected; reach it through the instance.
  const result = await (
    guard as unknown as { handleRequest: (p: ThrottlerRequest) => Promise<boolean> }
  ).handleRequest(props);
  return { result, enforced: storage.increment.mock.calls.length > 0 };
}

describe('PrincipalThrottlerGuard — INC-005 opt-IN buckets (Fix A1)', () => {
  let guard: PrincipalThrottlerGuard;
  let storage: ThrottlerStorage & { increment: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    ({ guard, storage } = await makeGuard());
  });

  // THE exact regression that bit: a routine read must NOT be subject to the
  // 5/60s `auth` bucket. The guard must exempt it (no storage increment), so
  // 6+ rapid reads can never 429 on the auth cap.
  it('GET /v1/projects (ProjectsController.list) is EXEMPT from the `auth` bucket', async () => {
    const { result, enforced } = await runBucket(
      guard,
      storage,
      'auth',
      ProjectsController.prototype.list,
      ProjectsController,
    );
    expect(result).toBe(true); // allowed
    expect(enforced).toBe(false); // auth bucket never counted this read
  });

  it('GET /v1/time-entries/running (TimeEntriesController.running) is EXEMPT from the `auth` bucket', async () => {
    const { result, enforced } = await runBucket(
      guard,
      storage,
      'auth',
      TimeEntriesController.prototype.running,
      TimeEntriesController,
    );
    expect(result).toBe(true);
    expect(enforced).toBe(false);
  });

  it('reads are EXEMPT from the `chatbot` bucket too (only opted-in routes carry it)', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'chatbot',
      ProjectsController.prototype.list,
      ProjectsController,
    );
    expect(enforced).toBe(false);
  });

  // Reads are STILL governed by the app-wide `global` bucket (1000/60s). It is
  // never opt-in, so it always runs (storage IS consulted).
  it('GET /v1/projects IS still governed by the app-wide `global` bucket', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'global',
      ProjectsController.prototype.list,
      ProjectsController,
    );
    expect(enforced).toBe(true); // global counts every read
  });

  // INC-003 guarantee preserved: login/callback DO opt into `auth` (class-level
  // @Throttle), so the guard enforces the 5/60s brute-force cap on them.
  it('POST /v1/auth/oidc/login (oidcLogin) IS enforced by the `auth` bucket', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'auth',
      AuthController.prototype.oidcLogin,
      AuthController,
    );
    expect(enforced).toBe(true); // brute-force cap intact
  });

  it('POST /v1/auth/oidc/callback (oidcCallback) IS enforced by the `auth` bucket', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'auth',
      AuthController.prototype.oidcCallback,
      AuthController,
    );
    expect(enforced).toBe(true);
  });

  // /me opts out of `auth` via @SkipThrottle({auth:true}) — must stay exempt.
  it('GET /v1/auth/me (me) is EXEMPT from the `auth` bucket (@SkipThrottle preserved)', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'auth',
      AuthController.prototype.me,
      AuthController,
    );
    expect(enforced).toBe(false);
  });

  // The chatbot postMessage route opts into `chatbot` — must stay enforced.
  it('POST /v1/chatbot/messages (postMessage) IS enforced by the `chatbot` bucket', async () => {
    const { enforced } = await runBucket(
      guard,
      storage,
      'chatbot',
      ChatbotController.prototype.postMessage,
      ChatbotController,
    );
    expect(enforced).toBe(true);
  });
});

describe('PrincipalThrottlerGuard — INC-005 per-principal getTracker (Fix B)', () => {
  it('returns `user:<id>` for an authenticated request', async () => {
    const { guard } = await makeGuard();
    const tracker = await (
      guard as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> }
    ).getTracker({ user: { userId: '42' }, ip: '10.0.0.9' });
    expect(tracker).toBe('user:42');
  });

  it('returns `ip:<addr>` for an unauthenticated request (no req.user)', async () => {
    const { guard } = await makeGuard();
    const tracker = await (
      guard as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> }
    ).getTracker({ ip: '203.0.113.7' });
    expect(tracker).toBe('ip:203.0.113.7');
  });

  it('prefixes guarantee a user id and an IP can never collide on the same key', async () => {
    const { guard } = await makeGuard();
    const asUser = await (
      guard as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> }
    ).getTracker({ user: { userId: '203.0.113.7' } });
    const asIp = await (
      guard as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> }
    ).getTracker({ ip: '203.0.113.7' });
    // Even when the literal value matches, the prefixed trackers differ.
    expect(asUser).toBe('user:203.0.113.7');
    expect(asIp).toBe('ip:203.0.113.7');
    expect(asUser).not.toBe(asIp);
  });

  it('falls back to `ip:unknown` when neither user nor ip is present (defensive)', async () => {
    const { guard } = await makeGuard();
    const tracker = await (
      guard as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> }
    ).getTracker({});
    expect(tracker).toBe('ip:unknown');
  });
});
