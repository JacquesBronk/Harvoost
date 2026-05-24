/**
 * In-memory mock backend for Harvoost e2e tests.
 *
 * Installed via installMockApi(page, { actorKey }). All requests made by the
 * web app to API_BASE_URL are intercepted; canned responses are derived from
 * RBAC_TEST_FIXTURE so the FRONTEND user-journey logic (RBAC-aware
 * navigation, timesheet submission, chatbot tool RBAC, leave booking) can
 * be exercised without a live API.
 *
 * **Per ADR-0001 (OIDC provider-agnostic; mock-OIDC deleted), the
 * `X-Mock-User-Id` header bypass is GONE.** The actor identity in this mock
 * is bound at install time to `opts.actorKey`. The presence/absence of the
 * `harvoost_session` cookie controls whether protected endpoints return 200
 * or 401. There is no header-based identity override.
 *
 * For live-mode tests (`E2E_LIVE=1`), this mock is bypassed entirely — the
 * Playwright `signInAs()` helper drives the real Keycloak login flow against
 * the docker-compose Keycloak service and the real backend's OIDC handler
 * validates the id_token via `jose`.
 *
 * What this mock DOES enforce (so tests don't accidentally pass when the
 * real backend would refuse):
 *   - RBAC scope: GET /v1/reports/team-dashboard returns only the users
 *     visible to the actor per visibleUserIds().
 *   - Idempotency: POST /v1/time-entries/start requires an Idempotency-Key
 *     header — a missing header is 400 VALIDATION_FAILED, mirroring backend.
 *   - Lock enforcement: PATCH/DELETE on submitted/manager_approved/
 *     final_approved entries returns 409 ENTRY_LOCKED.
 *   - Two-stage invariant: POST /v1/approvals/timesheets/final by the same
 *     actor who did stage-1 returns 409.
 *   - Chatbot scope: a query naming a user OUTSIDE the actor's
 *     visibleUserIds() returns an "out of scope" assistant reply.
 *   - Session lifecycle: the cookie is issued on /v1/auth/oidc/callback POST
 *     (HttpOnly, SameSite=Lax) and cleared on /v1/auth/logout POST. Calls to
 *     /v1/auth/me with `sessionActive=false` return 401.
 *
 * What this mock DOES NOT do: real DB persistence, real LLM, real Excel
 * generation, real id_token validation. The "live-stack" project covers
 * those (and goes through real Keycloak).
 */

import type { Page, Route, Request } from '@playwright/test';
import {
  USERS,
  PROJECTS,
  visibleProjectIds,
  visibleUserIds,
  type FixtureUser,
} from './rbac.js';

export const SESSION_TOKEN = 'mock-session-token-for-e2e';

interface MockState {
  actor: FixtureUser;
  // entries indexed by id
  entries: Map<string, MockTimeEntry>;
  leaveRequests: Map<string, MockLeaveRequest>;
  // exception records (Finding 2)
  exceptions: Map<string, MockException>;
  // approval tracking — entryId -> stage-1 approver userId
  stage1Approvers: Map<string, string>;
  // mood entries by user-date string
  moodByUserDate: Map<string, number>;
  // chatbot conversations by id
  conversations: Map<string, MockConversation>;
  // idempotency dedupe: idempotency-key -> entry
  idempotency: Map<string, MockTimeEntry>;
  // entry id sequence
  nextEntryId: number;
  // Whether the session cookie is currently valid (logout flips this off).
  sessionActive: boolean;
  // Throttle counters: route-key -> array of unix-ms timestamps in the active window.
  throttleHits: Map<string, number[]>;
}

interface MockException {
  id: string;
  user_id: string;
  type: 'MISSED_PUNCH' | 'OVERTIME_DAY' | 'OT_WEEK' | 'ANOMALY_LOW' | 'ANOMALY_HIGH';
  occurred_on: string;
  status: 'open' | 'resolved';
  resolved_by?: string | null;
  resolved_at?: string | null;
}

interface MockTimeEntry {
  id: string;
  user_id: string;
  project_id: string;
  project_name?: string;
  task_id?: string | null;
  task_name?: string | null;
  notes?: string | null;
  start_at: string;
  end_at?: string | null;
  hours?: number;
  status:
    | 'running'
    | 'draft'
    | 'submitted'
    | 'manager_approved'
    | 'final_approved'
    | 'rejected';
  billable: boolean;
  mood_score?: number | null;
  cost_rate?: number | null;
  cost_amount?: number | null;
  billable_rate?: number | null;
  billable_amount?: number | null;
}

interface MockLeaveRequest {
  id: string;
  user_id: string;
  user_name?: string;
  leave_type: 'annual' | 'sick' | 'unpaid' | 'other';
  start_date: string;
  end_date: string;
  half_day?: 'am' | 'pm' | null;
  note?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}

interface MockConversation {
  id: string;
  user_id: string;
  started_at: string;
  last_message_at: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    created_at: string;
  }>;
}

export interface InstallMockApiOpts {
  actorKey: FixtureUser['key'];
  apiBaseUrl?: string;
  /** Pre-seed entries for the actor's "last week" so the timesheets page isn't empty. */
  seedSampleEntries?: boolean;
  /** Pre-seed pending leave from an anchored employee (for manager approve flow). */
  seedPendingLeave?: { fromUserKey: FixtureUser['key'] };
  /** Override chatbot capabilities (default: enabled, gpt-4o). */
  chatbotCapabilities?: { enabled: boolean; reason?: string; provider?: string; model?: string };
  /** Force chatbot endpoint to return CHATBOT_DISABLED (used by capability-gate tests). */
  chatbotDisabled?: boolean;
  /** Approve overrides — when true, stage-2 by same actor as stage-1 still goes through (used to test the negative path). */
  allowSelfStage2?: boolean;
  /** Set the running timer at install time. */
  initialRunningEntry?: { project_key: keyof typeof PROJECTS; mood_score?: number };
  /**
   * If true, the mock-api does NOT seed the session cookie at install time —
   * the test is expected to trigger the OIDC callback path to receive the
   * Set-Cookie. Default false.
   */
  skipPreSeedSessionCookie?: boolean;
}

/**
 * Origins that the simulated backend CSRF middleware treats as allow-listed
 * (Finding 8 — matches the prod CORS_ALLOWED_ORIGINS shape). Tests can override
 * via `E2E_WEB_BASE_URL`.
 */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000',
  'http://localhost:3000',
]);

/** Throttle limits — mirror the @Throttle decorators in apps/api. */
export const THROTTLE_LIMITS: Record<string, { limit: number; ttlMs: number }> = {
  // POST /v1/auth/oidc/callback and other AuthController routes — 5/min.
  'auth': { limit: 5, ttlMs: 60_000 },
  // POST /v1/chatbot/messages — 30/min.
  'chatbot': { limit: 30, ttlMs: 60_000 },
};

export interface MockApiHandle {
  state: MockState;
  /** Return the network log so tests can assert idempotency-key reuse. */
  requests: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }>;
  /** Mark an entry's status forcibly — useful for setting up lock-enforcement tests. */
  setEntryStatus: (entryId: string, status: MockTimeEntry['status']) => void;
}

export async function installMockApi(
  page: Page,
  opts: InstallMockApiOpts,
): Promise<MockApiHandle> {
  const apiBaseUrl = opts.apiBaseUrl ?? process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
  const actor = USERS[opts.actorKey];

  const state: MockState = {
    actor,
    entries: new Map(),
    leaveRequests: new Map(),
    exceptions: new Map(),
    stage1Approvers: new Map(),
    moodByUserDate: new Map(),
    conversations: new Map(),
    idempotency: new Map(),
    nextEntryId: 1000,
    sessionActive: !opts.skipPreSeedSessionCookie,
    throttleHits: new Map(),
  };

  if (opts.seedSampleEntries) {
    seedSampleEntries(state);
  }
  if (opts.seedPendingLeave) {
    const fromUser = USERS[opts.seedPendingLeave.fromUserKey];
    const id = `leave-${fromUser.id}-001`;
    state.leaveRequests.set(id, {
      id,
      user_id: fromUser.id,
      user_name: fromUser.displayName,
      leave_type: 'annual',
      start_date: nextMonday(),
      end_date: nextFriday(),
      note: 'Family holiday',
      status: 'pending',
    });
  }
  if (opts.initialRunningEntry) {
    const proj = PROJECTS[opts.initialRunningEntry.project_key];
    const id = String(state.nextEntryId++);
    state.entries.set(id, {
      id,
      user_id: actor.id,
      project_id: proj.id,
      project_name: proj.name,
      task_id: null,
      task_name: 'General',
      start_at: new Date(Date.now() - 60_000).toISOString(),
      end_at: null,
      status: 'running',
      billable: proj.billingMode === 'hourly',
      mood_score: opts.initialRunningEntry.mood_score ?? null,
    });
  }

  const requests: MockApiHandle['requests'] = [];

  // Set the session cookie so the web app believes it is authenticated.
  // We set the cookie BEFORE any navigation so the first apiFetch picks it up.
  //
  // Per Finding 7 (HttpOnly cookie) the real backend issues this cookie via
  // Set-Cookie on the OIDC callback response. For tests that DO want to
  // exercise the cookie-issuance leg, pass `skipPreSeedSessionCookie: true`
  // and the cookie will only appear after the callback POST.
  if (!opts.skipPreSeedSessionCookie) {
    await page.context().addCookies([
      {
        name: 'harvoost_session',
        value: SESSION_TOKEN,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }

  // Match anything on the API origin.
  const apiPattern = new RegExp(
    `^${escapeRegExp(apiBaseUrl)}(/.*)?$`,
  );

  await page.route(apiPattern, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;
    let bodyJson: any = undefined;
    const rawBody = req.postData();
    if (rawBody) {
      try {
        bodyJson = JSON.parse(rawBody);
      } catch {
        // non-json body; leave undefined
      }
    }
    requests.push({
      method,
      url: req.url(),
      body: bodyJson,
      headers: req.headers(),
    });

    // CSRF middleware (Finding 8) — runs BEFORE the route handler for any
    // unsafe method, regardless of path. Safe methods (GET/HEAD/OPTIONS) and
    // bearer-authenticated requests are exempt.
    const csrfRejection = csrfCheck(method, path, req);
    let result: RouteResult;
    if (csrfRejection) {
      result = csrfRejection;
    } else {
      // Throttle middleware (Finding 4) — counts hits per limiter bucket.
      const throttleRejection = throttleCheck(state, method, path);
      if (throttleRejection) {
        result = throttleRejection;
      } else {
        result = await routeRequest(state, method, path, url.searchParams, bodyJson, req, opts);
      }
    }

    // Compose response headers — security headers (Finding 10) are always
    // present, mirroring the helmet config in apps/api/src/main.ts.
    const respHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': req.headers()['origin'] ?? 'http://localhost:3000',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Idempotency-Key, X-Requested-With',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };

    // Set-Cookie handling: ONLY the OIDC callback issues a Set-Cookie; the
    // logout endpoint clears it. Both are encoded on the result and applied
    // here so the cookie attributes (HttpOnly, SameSite=Lax, Path=/, Secure
    // when NODE_ENV=production) live in one place.
    if (result.setCookie) {
      respHeaders['Set-Cookie'] = result.setCookie;
    }

    return route.fulfill({
      status: result.status,
      contentType: 'application/json',
      headers: respHeaders,
      body: JSON.stringify(result.body ?? {}),
    });
  });

  return {
    state,
    requests,
    setEntryStatus(entryId, status) {
      const entry = state.entries.get(entryId);
      if (entry) entry.status = status;
    },
  };
}

interface RouteResult {
  status: number;
  body?: unknown;
  /**
   * Optional Set-Cookie header value to apply to the response. Used by the
   * OIDC callback (issues the harvoost_session cookie) and the logout
   * endpoint (clears it via Max-Age=0).
   */
  setCookie?: string;
}

/**
 * Origin / X-Requested-With CSRF check. Mirrors the backend CsrfMiddleware
 * at apps/api/src/common/middleware/csrf.middleware.ts. Safe methods and
 * bearer-authenticated requests are exempt; for cookie-authenticated
 * unsafe requests we require either an in-allowlist Origin or the
 * X-Requested-With: XMLHttpRequest header.
 */
function csrfCheck(method: string, _path: string, req: Request): RouteResult | null {
  const m = method.toUpperCase();
  // Safe methods pass through.
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  const headers = req.headers();
  const auth = headers['authorization'];
  // Bearer-authenticated callers (tray) are exempt.
  if (auth && auth.toLowerCase().startsWith('bearer ')) return null;
  const origin = headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) return null;
  // Match `X-Requested-With: XMLHttpRequest` case-insensitively.
  const xrw = headers['x-requested-with'];
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return null;
  return {
    status: 403,
    body: {
      code: 'CSRF_FAILURE',
      message:
        'Cross-origin request rejected. Browser callers must send X-Requested-With: XMLHttpRequest or originate from an allow-listed origin.',
    },
  };
}

/**
 * @Throttle decorator simulator (Finding 4). Counts unsafe requests per
 * limiter bucket within a sliding window. Returns a 429 result when the
 * cap is exceeded.
 */
function throttleCheck(state: MockState, method: string, path: string): RouteResult | null {
  // Auth bucket: POSTs under /v1/auth/ (5/60s). The real @Throttle decorator
  // counts every request, but for the hermetic mock we narrow to POST so a
  // GET /v1/auth/me triggered by AppShell mount doesn't bleed into the
  // burst budget. The behavioural assertion (5 POSTs pass, 6th 429) is the
  // load-bearing claim and is preserved.
  // Chatbot bucket: POST /v1/chatbot/messages only.
  let bucket: keyof typeof THROTTLE_LIMITS | null = null;
  if (method === 'POST' && path.startsWith('/v1/auth/')) bucket = 'auth';
  if (method === 'POST' && path === '/v1/chatbot/messages') bucket = 'chatbot';
  if (!bucket) return null;
  const limits = THROTTLE_LIMITS[bucket]!;
  const now = Date.now();
  const cutoff = now - limits.ttlMs;
  const key = `${bucket}:${path}`;
  const arr = state.throttleHits.get(key) ?? [];
  // Drop expired entries from the front.
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
  if (arr.length >= limits.limit) {
    state.throttleHits.set(key, arr);
    return {
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        message: `Too many requests for ${bucket}. Limit ${limits.limit}/${limits.ttlMs / 1000}s.`,
        details: { bucket, limit: limits.limit, ttl_ms: limits.ttlMs },
      },
    };
  }
  arr.push(now);
  state.throttleHits.set(key, arr);
  return null;
}

function routeRequest(
  state: MockState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: any,
  req: Request,
  opts: InstallMockApiOpts,
): RouteResult {
  // Handle OPTIONS preflight.
  if (method === 'OPTIONS') {
    return { status: 204, body: {} };
  }

  // Auth
  if (path === '/v1/auth/idp-info' && method === 'GET') {
    // Public / unauthenticated (ADR-0001 / INC-002). The login page renders
    // `display_name` in its copy + button label. Keycloak in dev, Entra in prod.
    return {
      status: 200,
      body: {
        display_name: 'Keycloak (dev)',
        issuer: 'http://localhost:8080/realms/harvoost',
      },
    };
  }
  if (path === '/v1/auth/oidc/login' && method === 'POST') {
    return {
      status: 201,
      body: {
        // Frontend reads `authorization_url`. Per the INC-002 canonical
        // contract the backend builds the redirect_uri server-side and returns
        // an opaque_state_id (uuid) the callback must echo back.
        authorization_url: `${process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000'}/auth/callback?code=mock-code&state=mock-state`,
        opaque_state_id: '00000000-0000-4000-8000-0000000000aa',
      },
    };
  }
  if (path === '/v1/auth/oidc/callback' && method === 'POST') {
    // Finding 7: backend now issues the session as an HttpOnly cookie via
    // Set-Cookie. The inline `session_token` in the JSON body is RETAINED for
    // one release with `_deprecated_inline_token: true` per the backend
    // HANDOFF (and ignored by the web client).
    state.sessionActive = true;
    const maxAgeSec = 12 * 3600;
    const isProd = process.env.NODE_ENV === 'production';
    const secureFlag = isProd ? '; Secure' : '';
    const setCookie =
      `harvoost_session=${SESSION_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secureFlag}`;
    return {
      status: 200,
      setCookie,
      body: {
        session_token: SESSION_TOKEN,
        _deprecated_inline_token: true,
        expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
        user: { id: state.actor.id, email: state.actor.email, roles: state.actor.roles },
      },
    };
  }
  if (path === '/v1/auth/me' && method === 'GET') {
    if (!state.sessionActive) {
      return { status: 401, body: { code: 'OIDC_FAILURE', message: 'No session' } };
    }
    return {
      status: 200,
      body: {
        id: state.actor.id,
        email: state.actor.email,
        display_name: state.actor.displayName,
        timezone: state.actor.timezone,
        roles: state.actor.roles,
        scope_summary: scopeSummaryFor(state.actor.key),
      },
    };
  }
  if (path === '/v1/auth/logout' && method === 'POST') {
    // Finding 7: backend clears the cookie via res.clearCookie. Encode the
    // expiry both via Max-Age=0 and an Expires-in-the-past so the browser
    // drops the cookie regardless of which attribute it honours.
    state.sessionActive = false;
    const setCookie =
      'harvoost_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    return { status: 200, setCookie, body: { ok: true } };
  }

  // Time entries
  if (path === '/v1/time-entries/running' && method === 'GET') {
    const running = Array.from(state.entries.values()).find(
      (e) => e.user_id === state.actor.id && e.status === 'running',
    );
    // FEAT-001 (GitHub #5): the live controller returns the `{ data }` envelope
    // (data = the running entry or null), and the web app reconciled to read
    // `data.data` (TimerBar.tsx / time-entries.ts). The old `{ running, ... }`
    // shape resolved to `undefined` under the new FE read, so a running entry
    // never surfaced in the bar. Mirror the live envelope here so the hermetic
    // TimerBar render assertions (clock-in.spec.ts) match the production read.
    return {
      status: 200,
      body: {
        data: running ?? null,
      },
    };
  }
  // Projects list — picker source for the FEAT-001 start/switch/manual controls
  // (StartTimerControl + NewEntryForm call GET /v1/projects?is_active=true and
  // read the OffsetPaginated `{ data, page, page_size }` envelope; ids are
  // strings). RBAC-scoped to the actor's visible projects so the picker only
  // offers projects they can actually clock into.
  if (path === '/v1/projects' && method === 'GET') {
    const visible = visibleProjectIds(state.actor.key);
    const data = Object.values(PROJECTS)
      .filter((p) => visible.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        client_id: '1',
        client_name: 'Demo Client Ltd',
        billing_mode: p.billingMode,
        is_active: true,
      }));
    return {
      status: 200,
      body: {
        data,
        page: Number(query.get('page') ?? 1),
        page_size: Number(query.get('page_size') ?? 100),
        total_count: data.length,
      },
    };
  }
  // Project tasks — OPTIONAL picker (FEAT-001 / gate (a) #1). The live read
  // endpoint GET /v1/projects/{project_id}/tasks returns `{ data: ProjectTask[] }`
  // with string ids; the seed gives every project a "General" task. The picker
  // degrades gracefully to "No tasks" on an empty list, so the exact contents
  // are not load-bearing — we return a single "General" task to mirror the seed.
  const projectTasksMatch = /^\/v1\/projects\/([^/]+)\/tasks$/.exec(path);
  if (projectTasksMatch && method === 'GET') {
    const projectId = projectTasksMatch[1]!;
    const visible = visibleProjectIds(state.actor.key);
    if (!visible.has(projectId)) {
      // Not in scope → empty list (the picker shows "No tasks", start still works).
      return { status: 200, body: { data: [] } };
    }
    return {
      status: 200,
      body: {
        data: [
          {
            id: `${projectId}-task-general`,
            project_id: projectId,
            name: 'General',
            is_billable: true,
            is_active: true,
          },
        ],
      },
    };
  }
  if (path === '/v1/time-entries' && method === 'GET') {
    const userId = query.get('user_id') ?? state.actor.id;
    if (userId !== state.actor.id && !canViewOther(state.actor.key, userId)) {
      return rbacForbidden();
    }
    const items = Array.from(state.entries.values()).filter((e) => e.user_id === userId);
    // GET /v1/time-entries is OFFSET-paginated: rows live under the `{ data, page,
    // page_size, total_count }` envelope (OffsetPaginated), NOT `{ items }`. The
    // /timesheets page reads `entriesQuery.data?.data` (the FEAT-002 envelope-read
    // fix), so the mock MUST return `{ data }` or the week table renders empty in
    // hermetic mode. (Kept `items` as a duplicate alias so any older reader still
    // works; the canonical key is `data`.)
    return {
      status: 200,
      body: {
        data: items,
        items,
        page: 1,
        page_size: items.length,
        total_count: items.length,
        next_cursor: null,
      },
    };
  }
  if (path === '/v1/time-entries/start' && method === 'POST') {
    const idemKey = req.headers()['idempotency-key'];
    if (!idemKey) return validationFailed('Idempotency-Key header is required for time-entries/start');
    if (state.idempotency.has(idemKey)) {
      return { status: 200, body: { entry: state.idempotency.get(idemKey) } };
    }
    if (!body?.project_id) return validationFailed('project_id is required');
    if (typeof body.mood_score !== 'number' || body.mood_score < 1 || body.mood_score > 5) {
      return validationFailed('mood_score (1-5) is required for new clock-in');
    }
    // Implicit stop of any existing running timer.
    for (const e of state.entries.values()) {
      if (e.user_id === state.actor.id && e.status === 'running') {
        const start = new Date(e.start_at).getTime();
        e.end_at = new Date().toISOString();
        e.hours = (Date.now() - start) / 3_600_000;
        e.status = 'draft';
      }
    }
    const id = String(state.nextEntryId++);
    const proj = Object.values(PROJECTS).find((p) => p.id === String(body.project_id));
    const entry: MockTimeEntry = {
      id,
      user_id: state.actor.id,
      project_id: String(body.project_id),
      project_name: proj?.name,
      task_id: body.task_id ?? null,
      task_name: 'General',
      notes: body.notes ?? null,
      start_at: new Date().toISOString(),
      end_at: null,
      status: 'running',
      billable: proj?.billingMode === 'hourly',
      mood_score: body.mood_score,
    };
    state.entries.set(id, entry);
    state.idempotency.set(idemKey, entry);
    state.moodByUserDate.set(`${state.actor.id}:${entry.start_at.slice(0, 10)}`, body.mood_score);
    return { status: 201, body: { entry } };
  }
  if (path === '/v1/time-entries/stop' && method === 'POST') {
    const idemKey = req.headers()['idempotency-key'];
    if (!idemKey) return validationFailed('Idempotency-Key header is required for time-entries/stop');
    if (state.idempotency.has(idemKey)) {
      return { status: 200, body: { entry: state.idempotency.get(idemKey) } };
    }
    const running = Array.from(state.entries.values()).find(
      (e) => e.user_id === state.actor.id && e.status === 'running',
    );
    if (!running) return { status: 200, body: { entry: null } };
    const start = new Date(running.start_at).getTime();
    running.end_at = new Date().toISOString();
    running.hours = Math.max(0.001, (Date.now() - start) / 3_600_000);
    running.status = 'draft';
    state.idempotency.set(idemKey, running);
    return { status: 200, body: { entry: running } };
  }
  // Submit week via POST /v1/time-entries/:id/submit { scope: 'week' }.
  // FEAT-002 (GitHub #6): the /timesheets page now consumes the REAL pinned
  // shape `{ submitted_ids: string[], skipped: [{entry_id, reason}] }` (from
  // HANDOFF_backend.md) — summarizeSubmitResult() reads result.submitted_ids
  // .length and result.skipped, so the prior `{ ok: true }` stub made the page
  // throw and surface "Submission failed". Return the contract-faithful shape:
  // flip draft → submitted, skip running ("running") + already-locked
  // ("already_submitted"), reporting both buckets exactly like the live API.
  const submitMatch = /^\/v1\/time-entries\/([^/]+)\/submit$/.exec(path);
  if (submitMatch && method === 'POST') {
    const anchor = state.entries.get(submitMatch[1]!);
    if (!anchor || anchor.user_id !== state.actor.id) {
      return { status: 404, body: { code: 'NOT_FOUND', message: 'Entry not found' } };
    }
    const submittedIds: string[] = [];
    const skipped: Array<{ entry_id: string; reason: 'running' | 'already_submitted' }> = [];
    if (body?.scope === 'week') {
      for (const e of state.entries.values()) {
        if (e.user_id !== state.actor.id) continue;
        if (e.status === 'draft') {
          e.status = 'submitted';
          submittedIds.push(e.id);
        } else if (e.status === 'running') {
          skipped.push({ entry_id: e.id, reason: 'running' });
        } else if (
          e.status === 'submitted' ||
          e.status === 'manager_approved' ||
          e.status === 'final_approved'
        ) {
          skipped.push({ entry_id: e.id, reason: 'already_submitted' });
        }
      }
    } else {
      // scope=entry — submit just the anchor.
      if (anchor.status === 'draft') {
        anchor.status = 'submitted';
        submittedIds.push(anchor.id);
      } else if (anchor.status === 'running') {
        skipped.push({ entry_id: anchor.id, reason: 'running' });
      } else {
        skipped.push({ entry_id: anchor.id, reason: 'already_submitted' });
      }
    }
    return { status: 200, body: { submitted_ids: submittedIds, skipped } };
  }

  // GET /v1/timesheet-periods/{iso_week} (self) — FEAT-002. The /timesheets page
  // reads this on load to drive the locked banner + Submit-week gating. Without a
  // handler this 404'd (the page tolerates that via retry:false, but the banner
  // never showed in mocked mode). Synthesize a derived rollup of the actor's
  // entries: the LEAST-advanced approval state among non-running entries (rejected
  // pulls to rejected; all-final → final_approved; etc.), matching the backend
  // rollup. {iso_week} is the YYYY-Www token; we do NOT bucket by real week here
  // (the mock seeds all entries "this week"), so the status reflects the actor's
  // whole entry set — sufficient for the page's submitted/locked UI in mocked mode.
  const periodMatch = /^\/v1\/timesheet-periods\/(\d{4})-W(\d{2})$/.exec(path);
  if (periodMatch && method === 'GET') {
    const isoYear = Number(periodMatch[1]);
    const isoWeek = Number(periodMatch[2]);
    const counts = { draft: 0, submitted: 0, manager_approved: 0, final_approved: 0, rejected: 0 };
    for (const e of state.entries.values()) {
      if (e.user_id !== state.actor.id) continue;
      if (e.status === 'running') continue;
      if (e.status in counts) counts[e.status as keyof typeof counts]++;
    }
    const total =
      counts.draft + counts.submitted + counts.manager_approved + counts.final_approved + counts.rejected;
    let status: 'open' | 'submitted' | 'manager_approved' | 'final_approved' | 'rejected';
    if (total === 0) status = 'open';
    else if (counts.rejected > 0) status = 'rejected';
    else if (counts.final_approved === total) status = 'final_approved';
    else if (counts.manager_approved + counts.final_approved === total) status = 'manager_approved';
    else if (counts.draft === 0) status = 'submitted';
    else status = 'open';
    const hasRow = status !== 'open';
    return {
      status: 200,
      body: {
        ...(hasRow ? { id: `period-${state.actor.id}-${isoYear}-${isoWeek}` } : {}),
        user_id: state.actor.id,
        iso_year: isoYear,
        iso_week: isoWeek,
        week_start_date: hasRow ? '2026-05-18' : null,
        status,
        submitted_at: status !== 'open' ? new Date().toISOString() : null,
        submitted_by: status !== 'open' ? state.actor.id : null,
        manager_approved_at: null,
        final_approved_at: null,
        reopened_at: null,
        entry_counts: counts,
      },
    };
  }
  // Edit / delete with lock enforcement.
  const editMatch = /^\/v1\/time-entries\/([^/]+)$/.exec(path);
  if (editMatch && (method === 'PATCH' || method === 'DELETE')) {
    const entry = state.entries.get(editMatch[1]!);
    if (!entry || entry.user_id !== state.actor.id) {
      return { status: 404, body: { code: 'NOT_FOUND', message: 'Entry not found' } };
    }
    if (
      entry.status === 'submitted' ||
      entry.status === 'manager_approved' ||
      entry.status === 'final_approved'
    ) {
      return {
        status: 409,
        body: {
          code: 'ENTRY_LOCKED',
          message: `This time entry is locked (status=${entry.status}).`,
        },
      };
    }
    if (method === 'PATCH') {
      Object.assign(entry, body ?? {});
      return { status: 200, body: { entry } };
    }
    state.entries.delete(entry.id);
    return { status: 204, body: undefined };
  }

  // Mood
  if (path === '/v1/mood/entries' && method === 'POST') {
    const today = new Date().toISOString().slice(0, 10);
    const k = `${state.actor.id}:${today}`;
    if (state.moodByUserDate.has(k)) {
      return validationFailed('Mood already captured for today');
    }
    if (!body?.score || body.score < 1 || body.score > 5) {
      return validationFailed('score (1-5) is required');
    }
    state.moodByUserDate.set(k, body.score);
    return { status: 201, body: { ok: true } };
  }
  if (path === '/v1/mood/me' && method === 'GET') {
    const items: Array<{ local_date: string; score: number }> = [];
    for (const [k, score] of state.moodByUserDate) {
      const [uid, date] = k.split(':');
      if (uid === state.actor.id) items.push({ local_date: date!, score });
    }
    return { status: 200, body: { items } };
  }
  if (path === '/v1/mood/team-aggregate' && method === 'GET') {
    // k>=5 anonymity enforcement. Our fixture has 4 employees -> always trip.
    return {
      status: 422,
      body: {
        code: 'K_ANONYMITY_THRESHOLD',
        message: 'Not enough data to show this aggregate (privacy threshold).',
        details: { threshold: 5, sample_size: 4 },
      },
    };
  }

  // Reports
  if (path === '/v1/reports/team-dashboard' && method === 'GET') {
    const fullScope = visibleUserIds(state.actor.key);
    const visibleIds = new Set(fullScope);
    visibleIds.delete(state.actor.id); // dashboard hides self by convention
    const items = Array.from(visibleIds).map((uid) => {
      const u = Object.values(USERS).find((x) => x.id === uid)!;
      return {
        user_id: u.id,
        display_name: u.displayName,
        total_hours: 32.5,
        hours_by_project: [
          { project_id: PROJECTS.P1.id, project_name: PROJECTS.P1.name, hours: 20 },
          { project_id: PROJECTS.P2.id, project_name: PROJECTS.P2.name, hours: 12.5 },
        ],
        missed_punch_count: 0,
        overtime_count: 0,
      };
    });
    return {
      status: 200,
      body: {
        items,
        scope_meta: {
          visible_users:
            state.actor.roles.includes('admin') || state.actor.roles.includes('finmgr')
              ? -1
              : fullScope.size,
          visible_projects:
            state.actor.roles.includes('admin') || state.actor.roles.includes('finmgr')
              ? -1
              : visibleProjectIds(state.actor.key).size,
        },
      },
    };
  }
  if (path === '/v1/reports/detailed-activity' && method === 'GET') {
    const includesCost = state.actor.roles.some((r) => r === 'admin' || r === 'finmgr');
    const items = Array.from(state.entries.values()).map((e) => {
      const out: any = { ...e };
      if (!includesCost) {
        delete out.cost_rate;
        delete out.cost_amount;
        delete out.billable_rate;
        delete out.billable_amount;
      }
      return out;
    });
    return { status: 200, body: { items } };
  }

  // Approvals
  if (path === '/v1/approvals/queue' && method === 'GET') {
    const stage = query.get('stage');
    const items: any[] = [];
    const byUser = new Map<string, MockTimeEntry[]>();
    for (const e of state.entries.values()) {
      if (stage === 'manager' && e.status === 'submitted') {
        if (!visibleUserIds(state.actor.key).has(e.user_id)) continue;
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
      }
      if (stage === 'final' && e.status === 'manager_approved') {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
      }
    }
    for (const [uid, entries] of byUser) {
      const u = Object.values(USERS).find((x) => x.id === uid)!;
      items.push({
        id: `wk-${uid}`,
        user_id: uid,
        user_name: u.displayName,
        iso_week: '2026-W21',
        total_hours: entries.reduce((s, e) => s + (e.hours ?? 0), 0),
        status: entries[0]!.status,
        submitted_at: new Date().toISOString(),
      });
    }
    // GET /v1/approvals/queue returns the enriched ApprovalQueueItem rows under the
    // `{ data }` envelope (the pinned FEAT-002 contract). The approvals page reads
    // `queue.data?.data` (the envelope-read fix), so the mock MUST return `{ data }`
    // or the queue renders empty + the per-row UnlockWeekButton is unreachable in
    // hermetic mode. (Kept `items` as a duplicate alias for safety.)
    return { status: 200, body: { data: items, items, next_cursor: null } };
  }
  if (path === '/v1/approvals/timesheets/manager' && method === 'POST') {
    const ids = (body?.entry_ids as string[]) ?? [];
    if (body?.action === 'approve') {
      for (const id of ids) {
        const e = state.entries.get(id);
        if (e && e.status === 'submitted') {
          e.status = 'manager_approved';
          state.stage1Approvers.set(id, state.actor.id);
        }
      }
    } else if (body?.action === 'reject') {
      if (!body?.reason || String(body.reason).length < 10) {
        return validationFailed('reject_reason must be ≥10 chars');
      }
      for (const id of ids) {
        const e = state.entries.get(id);
        if (e) e.status = 'rejected';
      }
    }
    return { status: 200, body: { ok: true } };
  }
  if (path === '/v1/approvals/timesheets/final' && method === 'POST') {
    const ids = (body?.entry_ids as string[]) ?? [];
    if (body?.action === 'approve') {
      for (const id of ids) {
        const stage1 = state.stage1Approvers.get(id);
        if (stage1 === state.actor.id && !opts.allowSelfStage2) {
          return {
            status: 409,
            body: {
              code: 'VALIDATION_FAILED',
              message:
                'Stage-2 approver must be different from stage-1 approver on the same entry.',
            },
          };
        }
        const e = state.entries.get(id);
        if (e && e.status === 'manager_approved') {
          e.status = 'final_approved';
        }
      }
    }
    return { status: 200, body: { ok: true } };
  }

  // Leave
  if (path === '/v1/leave/requests' && method === 'GET') {
    const mine = query.get('mine') === 'true';
    const status = query.get('status');
    let items = Array.from(state.leaveRequests.values());
    if (mine) items = items.filter((r) => r.user_id === state.actor.id);
    if (status) items = items.filter((r) => r.status === status);
    if (!mine) {
      const visible = visibleUserIds(state.actor.key);
      items = items.filter((r) => visible.has(r.user_id));
    }
    return { status: 200, body: { items, next_cursor: null } };
  }
  if (path === '/v1/leave/requests' && method === 'POST') {
    if (!body?.leave_type || !body?.start_date || !body?.end_date) {
      return validationFailed('leave_type, start_date, end_date are required');
    }
    const id = `leave-${state.actor.id}-${state.leaveRequests.size + 1}`;
    const req: MockLeaveRequest = {
      id,
      user_id: state.actor.id,
      user_name: state.actor.displayName,
      leave_type: body.leave_type,
      start_date: body.start_date,
      end_date: body.end_date,
      half_day: body.half_day ?? null,
      note: body.note ?? null,
      status: 'pending',
    };
    state.leaveRequests.set(id, req);
    return { status: 201, body: req };
  }
  const leaveApproveMatch = /^\/v1\/leave\/requests\/([^/]+)\/approve$/.exec(path);
  if (leaveApproveMatch && (method === 'PATCH' || method === 'POST')) {
    const r = state.leaveRequests.get(leaveApproveMatch[1]!);
    if (!r) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
    // Finding 1: RBAC role gate — only Manager/Admin/FinMgr can approve.
    if (!hasApprovalRole(state.actor)) return rbacForbidden();
    // Finding 1: self-approval guard — block when actor.id === leave.user_id.
    if (state.actor.id === r.user_id) {
      return {
        status: 403,
        body: {
          code: 'RBAC_FORBIDDEN',
          message: 'Cannot self-approve leave.',
        },
      };
    }
    // Finding 1: scope check — manager must be able to see the leave's user.
    if (!visibleUserIds(state.actor.key).has(r.user_id)) return rbacForbidden();
    r.status = 'approved';
    return { status: 200, body: r };
  }
  const leaveRejectMatch = /^\/v1\/leave\/requests\/([^/]+)\/reject$/.exec(path);
  if (leaveRejectMatch && (method === 'PATCH' || method === 'POST')) {
    const r = state.leaveRequests.get(leaveRejectMatch[1]!);
    if (!r) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
    // Finding 1: role + scope + self-action guards apply to reject as well.
    if (!hasApprovalRole(state.actor)) return rbacForbidden();
    if (state.actor.id === r.user_id) {
      return {
        status: 403,
        body: {
          code: 'RBAC_FORBIDDEN',
          message: 'Cannot self-reject leave.',
        },
      };
    }
    if (!visibleUserIds(state.actor.key).has(r.user_id)) return rbacForbidden();
    if (!body?.reason || String(body.reason).length < 10) {
      return validationFailed('reject reason must be ≥10 chars');
    }
    r.status = 'rejected';
    return { status: 200, body: r };
  }

  // Exceptions (Finding 2 — self-resolve only in v1).
  if (path === '/v1/exceptions' && method === 'GET') {
    const visible = visibleUserIds(state.actor.key);
    const items = Array.from(state.exceptions.values()).filter((e) => visible.has(e.user_id));
    return { status: 200, body: { items, next_cursor: null } };
  }
  const exceptionResolveMatch = /^\/v1\/exceptions\/([^/]+)\/resolve$/.exec(path);
  if (exceptionResolveMatch && (method === 'PATCH' || method === 'POST')) {
    const exc = state.exceptions.get(exceptionResolveMatch[1]!);
    if (!exc) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
    // Finding 2: v1 default — self-resolve only. Managers, admins, finmgrs
    // are all forbidden when they are not the owner.
    if (exc.user_id !== state.actor.id) {
      return {
        status: 403,
        body: {
          code: 'RBAC_FORBIDDEN',
          message: 'Exceptions can only be resolved by the user they belong to.',
        },
      };
    }
    exc.status = 'resolved';
    exc.resolved_by = state.actor.id;
    exc.resolved_at = new Date().toISOString();
    return { status: 200, body: exc };
  }

  // Chatbot
  if (path === '/v1/chatbot/capabilities' && method === 'GET') {
    if (opts.chatbotDisabled || opts.chatbotCapabilities?.enabled === false) {
      return {
        status: 200,
        body: {
          enabled: false,
          reason: opts.chatbotCapabilities?.reason ?? 'tool_calling_not_supported_by_provider',
          provider: opts.chatbotCapabilities?.provider ?? 'ollama',
          model: opts.chatbotCapabilities?.model ?? 'phi3',
        },
      };
    }
    return {
      status: 200,
      body: {
        enabled: true,
        reason: null,
        provider: 'openai',
        model: 'gpt-4o',
      },
    };
  }
  if (path === '/v1/chatbot/conversations' && method === 'GET') {
    const items = Array.from(state.conversations.values())
      .filter((c) => c.user_id === state.actor.id)
      .map((c) => ({
        id: c.id,
        started_at: c.started_at,
        last_message_at: c.last_message_at,
      }));
    return { status: 200, body: { items, next_cursor: null } };
  }
  const convMessagesMatch = /^\/v1\/chatbot\/conversations\/([^/]+)\/messages$/.exec(path);
  if (convMessagesMatch && method === 'GET') {
    const c = state.conversations.get(convMessagesMatch[1]!);
    if (!c || c.user_id !== state.actor.id) {
      return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
    }
    return { status: 200, body: { items: c.messages, next_cursor: null } };
  }
  if (path === '/v1/chatbot/messages' && method === 'POST') {
    if (opts.chatbotDisabled) {
      return {
        status: 503,
        body: {
          code: 'CHATBOT_DISABLED',
          message: 'The chatbot is currently unavailable.',
          details: { provider: 'ollama', model: 'phi3' },
        },
      };
    }
    const msg = String(body?.message ?? '');
    let conversationId = body?.conversation_id as string | undefined;
    if (!conversationId) {
      conversationId = `conv-${state.actor.id}-${state.conversations.size + 1}`;
      state.conversations.set(conversationId, {
        id: conversationId,
        user_id: state.actor.id,
        started_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        messages: [],
      });
    }
    const conv = state.conversations.get(conversationId)!;
    const visible = visibleUserIds(state.actor.key);
    // Cheap intent classifier: find a user name in the prompt, check scope.
    const lower = msg.toLowerCase();
    let targetUserKey: FixtureUser['key'] | null = null;
    // Match by FIRST NAME (e.g., "Bob") in the user's displayName ("Bob Employee").
    for (const u of Object.values(USERS)) {
      const firstName = u.displayName.split(' ')[0]!.toLowerCase();
      // Word-boundary match so "carol" doesn't pick up "carolyn", etc.
      const re = new RegExp(`\\b${firstName}\\b`, 'i');
      if (re.test(lower)) {
        targetUserKey = u.key;
        break;
      }
    }
    let reply: string;
    let toolCalls: Array<{ name: string; input: unknown; output: unknown }> = [];
    if (targetUserKey) {
      const target = USERS[targetUserKey];
      if (!visible.has(target.id)) {
        // Out of scope refusal. Crucially: do not confirm or deny target existence.
        reply =
          "I can only answer about people and projects you have access to. " +
          `${target.displayName.split(' ')[0]} is not in your visible scope.`;
        toolCalls = [
          {
            name: 'find_user_by_name',
            input: { name_query: target.displayName },
            output: { error: 'out_of_scope' },
          },
        ];
      } else {
        reply = `${target.displayName} logged 32.5 hours this week across the projects you can see.`;
        toolCalls = [
          {
            name: 'get_user_hours',
            input: { user_id: target.id, date_range: 'this_week' },
            output: { total_hours: 32.5 },
          },
        ];
      }
    } else if (/ignore previous|override rbac|switch identity|raw sql/i.test(msg)) {
      // Prompt-injection refusal.
      reply =
        "I won't override the scoping rules. I can only answer about people and projects you have access to.";
    } else {
      reply = "I'm not sure how to answer that — try rephrasing, or use the dashboard filters.";
    }
    const now = new Date().toISOString();
    conv.messages.push({
      id: `m-${conv.messages.length + 1}`,
      role: 'user',
      content: msg,
      created_at: now,
    });
    for (const tc of toolCalls) {
      conv.messages.push({
        id: `m-${conv.messages.length + 1}`,
        role: 'tool',
        tool_name: tc.name,
        tool_input: tc.input,
        tool_output: tc.output,
        created_at: now,
      });
    }
    conv.messages.push({
      id: `m-${conv.messages.length + 1}`,
      role: 'assistant',
      content: reply,
      created_at: now,
    });
    conv.last_message_at = now;
    return {
      status: 200,
      body: {
        conversation_id: conversationId,
        reply,
        tool_calls: toolCalls,
        usage: { prompt_tokens: 64, completion_tokens: 32 },
        provider: 'openai',
        model: 'gpt-4o',
      },
    };
  }

  // Catch-all
  return {
    status: 404,
    body: { code: 'NOT_FOUND', message: `No mock handler for ${method} ${path}` },
  };
}

function scopeSummaryFor(actorKey: FixtureUser['key']): {
  visible_users_count: number;
  visible_projects_count: number;
} {
  const actor = USERS[actorKey];
  if (actor.roles.includes('admin') || actor.roles.includes('finmgr')) {
    return { visible_users_count: -1, visible_projects_count: -1 };
  }
  return {
    visible_users_count: visibleUserIds(actorKey).size,
    visible_projects_count: visibleProjectIds(actorKey).size,
  };
}

function canViewOther(actorKey: FixtureUser['key'], userId: string): boolean {
  return visibleUserIds(actorKey).has(userId);
}

/**
 * Finding 1: Leave approve/reject is restricted to Manager / Admin / FinMgr
 * roles. Plain Employees are 403 RBAC_FORBIDDEN even when self-targeted.
 */
function hasApprovalRole(user: FixtureUser): boolean {
  return user.roles.some((r) => r === 'manager' || r === 'admin' || r === 'finmgr');
}

function rbacForbidden(): RouteResult {
  return {
    status: 403,
    body: { code: 'RBAC_FORBIDDEN', message: 'You do not have access to this resource.' },
  };
}

function validationFailed(message: string): RouteResult {
  return { status: 400, body: { code: 'VALIDATION_FAILED', message } };
}

function hoursTodayFor(state: MockState, userId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  let sum = 0;
  for (const e of state.entries.values()) {
    if (e.user_id !== userId) continue;
    if (e.start_at.slice(0, 10) !== today) continue;
    if (e.hours) sum += e.hours;
  }
  return Number(sum.toFixed(2));
}

function seedSampleEntries(state: MockState): void {
  // One submitted-week scenario, two draft entries from "earlier this week".
  const now = Date.now();
  for (let dayOffset = 1; dayOffset <= 3; dayOffset++) {
    const id = String(state.nextEntryId++);
    const start = new Date(now - dayOffset * 24 * 3600_000);
    start.setUTCHours(7, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3600_000);
    state.entries.set(id, {
      id,
      user_id: state.actor.id,
      project_id: PROJECTS.P1.id,
      project_name: PROJECTS.P1.name,
      task_id: null,
      task_name: 'General',
      notes: `Sample entry day-${dayOffset}`,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      hours: 2,
      status: 'draft',
      billable: true,
    });
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((1 + 7 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function nextFriday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((5 + 7 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}
