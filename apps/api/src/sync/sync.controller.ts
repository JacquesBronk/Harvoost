import { Controller, Sse, Req } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable, fromEvent, interval, map, merge, takeUntil, finalize } from 'rxjs';
import type { Request } from 'express';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { SyncService, type SyncEvent } from './sync.service';

// GET /v1/sync/events — Server-Sent Events stream filtered to the requesting
// user. Events emitted by time-entries controller (start/stop/switch),
// approvals controller (entry.submitted/approved/rejected), leave controller
// (leave.created/approved/rejected), etc.
//
// Auth: handled by the global BearerAuthGuard (Bearer token OR HttpOnly cookie).
// Heartbeat: a no-op event every 30s so proxies + load balancers don't close
// the connection on idle.
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Sse('events')
  events(
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Observable<MessageEvent> {
    const { subject, unsubscribe } = this.sync.subscribe(user.userId);
    // RxJS stream of the user's real events.
    const events$ = subject.asObservable().pipe(
      map((evt: SyncEvent): MessageEvent => ({
        type: evt.type,
        data: { type: evt.type, data: evt.data, ts: evt.ts },
      })),
    );
    // Heartbeat every 30s — emits a comment-style event the browser EventSource
    // accepts as keep-alive. NestJS's @Sse expects a MessageEvent shape.
    const heartbeat$ = interval(30_000).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { ts: new Date().toISOString() } })),
    );

    // When the HTTP request closes, tear down the subject + complete the stream.
    const close$ = fromEvent(req, 'close');

    return merge(events$, heartbeat$).pipe(
      takeUntil(close$),
      finalize(() => {
        // Clean up the registry slot whether close came from client disconnect
        // or downstream error. unsubscribe is idempotent in SyncService.
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      }),
    );
  }
}
