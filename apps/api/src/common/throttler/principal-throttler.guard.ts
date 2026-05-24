import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';

// @nestjs/throttler metadata-key prefixes. These are NOT re-exported from the
// package's public entry (only from the deep `dist/throttler.constants` path),
// so we mirror the literals here rather than depend on a private deep import.
// They are the SAME strings the guard itself reads at runtime and the same the
// existing throttler.test.ts asserts against — i.e. stable public contract.
//   @Throttle({ <name>: { limit } })  -> Reflect metadata `THROTTLER:LIMIT<name>`
//   @SkipThrottle({ <name>: true })   -> Reflect metadata `THROTTLER:SKIP<name>`
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_SKIP = 'THROTTLER:SKIP';

// INC-005 (issue #8) — per-principal rate limiting + opt-IN named buckets.
//
// Two problems this guard fixes, both rooted in @nestjs/throttler v6.5.0
// behaviour (verified against the installed source, throttler.guard.js):
//
//  1) OPT-IN buckets (Fix A1).
//     The stock guard iterates EVERY named throttler declared in
//     `ThrottlerModule.forRoot([...])` on EVERY route, applying that bucket's
//     `forRoot` limit unless the route `@SkipThrottle`s it by name
//     (throttler.guard.js canActivate: `for (const namedThrottler of
//     this.throttlers)` + `routeOrClassLimit || namedThrottler.limit`). With
//     `auth` (5/60s) and `chatbot` (30/60s) declared in forRoot, the smallest
//     bucket therefore capped EVERY route — a single user's normal page
//     fan-out (~4-6 reads) tripped the 5/60s `auth` cap. In v6.5.0 a
//     route-level `@Throttle({ name })` referencing a name NOT in forRoot is
//     never enforced (the guard only loops over `this.throttlers`), so the
//     plan's option (i) is impossible in this version. We use option (ii):
//     keep `auth`/`chatbot` in forRoot for their `@Throttle`-decorated routes,
//     but make them genuinely OPT-IN here — a route is exempt from an opt-in
//     bucket UNLESS it carries explicit `@Throttle({ <bucket> })` metadata.
//     Routine reads are then governed ONLY by the app-wide `global` bucket.
//
//  2) PER-PRINCIPAL tracker (Fix B).
//     The stock `getTracker` returns `req.ip`, so every tab/user behind one IP
//     shares each route's budget. We key by the authenticated user id when
//     present (BearerAuthGuard runs first and sets `req.user = { userId, ... }`),
//     falling back to the IP for unauthenticated routes (login/callback). The
//     `user:` / `ip:` prefixes guarantee a user id and an IP can never collide.
//
// NOTE (storage): the app uses the in-memory ThrottlerStorage (the forRoot
// default). That is per-process only — counters are NOT shared across API
// instances. A Redis-backed ThrottlerStorage is a documented v1.1 follow-up
// before horizontal scaling.

// Buckets that must NOT apply to a route unless that route explicitly opts in
// via @Throttle({ <name>: {...} }). `global` is intentionally absent: it stays
// app-wide (every route is governed by it). `default` is also absent (unused).
const OPT_IN_BUCKETS: readonly string[] = ['auth', 'chatbot'];

interface AuthedRequest {
  user?: { userId?: string };
  ip?: string;
}

@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  // Per-principal key. Authenticated → `user:<id>`; otherwise → `ip:<addr>`.
  // The variants are prefixed so a numeric user id and an IP literal can never
  // hash to the same bucket. Returns a stable string even if ip is somehow
  // undefined (defensive — express always sets req.ip behind a real server).
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as AuthedRequest;
    const userId = r.user?.userId;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }
    return `ip:${r.ip ?? 'unknown'}`;
  }

  // Per-bucket opt-in. The stock guard's shouldSkip() is all-or-nothing across
  // buckets, so we enforce opt-in at the per-bucket handleRequest hook instead:
  // for an OPT_IN bucket, no-op (return true = "allowed, not throttled") unless
  // the route declared an explicit limit for that bucket via @Throttle. We read
  // the SAME metadata key the stock guard reads (THROTTLER:LIMIT<name> via
  // reflector.getAllAndOverride([handler, classRef])), so "opted in" means
  // exactly what the stock guard would have honoured. An explicit
  // @SkipThrottle({ <name>: true }) on a handler (e.g. /me skipping `auth`)
  // still wins. The `global` bucket is never in OPT_IN_BUCKETS, so it always
  // runs through the real super.handleRequest (the only app-wide limit).
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = requestProps.throttler.name ?? 'default';
    if (OPT_IN_BUCKETS.includes(name)) {
      const targets = [requestProps.context.getHandler(), requestProps.context.getClass()];
      const optedIn =
        this.reflector.getAllAndOverride<number | undefined>(`${THROTTLER_LIMIT}${name}`, targets) !==
        undefined;
      const explicitlySkipped =
        this.reflector.getAllAndOverride<boolean | undefined>(`${THROTTLER_SKIP}${name}`, targets) ===
        true;
      if (!optedIn || explicitlySkipped) {
        // Route did not opt into this brute-force/chatbot bucket → exempt it.
        return true;
      }
    }
    return super.handleRequest(requestProps);
  }
}
