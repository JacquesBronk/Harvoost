import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';

// Server-Sent Events pub/sub registry. Maps user_id → set of RxJS Subjects
// (one per active SSE connection). emit(userId, event) fans out to every
// subscriber for that user.
//
// IMPORTANT: this is IN-PROCESS pub/sub. It works correctly for a single API
// replica (e.g., local dev, single-instance Container Apps). For multi-replica
// production, replace this with Redis pub/sub or Azure Service Bus topics —
// see ARCHITECTURE.md § Tray↔web sync.

export interface SyncEvent {
  type: string; // e.g., 'timer.started', 'timer.stopped', 'entry.submitted'
  data?: unknown;
  ts?: string;
}

@Injectable()
export class SyncService implements OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  // Map<userId, Set<Subject>> — one Subject per active SSE connection for that user.
  private readonly subscribers = new Map<string, Set<Subject<SyncEvent>>>();

  // Returns a Subject that the SSE controller turns into an Observable<MessageEvent>.
  // Caller MUST invoke unsubscribe() in the request's `close` handler to free the slot.
  subscribe(userId: string): { subject: Subject<SyncEvent>; unsubscribe: () => void } {
    const subject = new Subject<SyncEvent>();
    let bucket = this.subscribers.get(userId);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(userId, bucket);
    }
    bucket.add(subject);
    return {
      subject,
      unsubscribe: () => {
        const b = this.subscribers.get(userId);
        if (b) {
          b.delete(subject);
          if (b.size === 0) this.subscribers.delete(userId);
        }
        subject.complete();
      },
    };
  }

  // Fan-out: every subscriber for the user gets the event. Synchronous; if a
  // subject throws (shouldn't, as Subject.next never throws), we log and continue.
  emit(userId: string, event: SyncEvent): void {
    const bucket = this.subscribers.get(userId);
    if (!bucket || bucket.size === 0) return;
    const enriched: SyncEvent = { ...event, ts: event.ts ?? new Date().toISOString() };
    for (const subject of bucket) {
      try {
        subject.next(enriched);
      } catch (err) {
        this.logger.warn('sync.emit.subject_error', {
          userId,
          type: event.type,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Diagnostics: subscriber count for a user (used in unit tests).
  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }

  onModuleDestroy(): void {
    // Drain all open subjects on shutdown so RxJS doesn't keep the process alive.
    for (const bucket of this.subscribers.values()) {
      for (const s of bucket) s.complete();
    }
    this.subscribers.clear();
  }
}
