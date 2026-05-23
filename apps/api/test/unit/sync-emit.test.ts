import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../../src/sync/sync.service';

// Item 11: SSE pub/sub registry. Asserts:
//   - subscribers are scoped per-userId (no cross-user leak)
//   - emit fans out to every subject for that user
//   - unsubscribe removes the subject from the registry

describe('SyncService — pub/sub registry', () => {
  it('subscribes a user and emits scoped events', async () => {
    const svc = new SyncService();
    const events: unknown[] = [];
    const { subject, unsubscribe } = svc.subscribe('user-1');
    const sub = subject.subscribe((e) => events.push(e));

    svc.emit('user-1', { type: 'timer.started', data: { id: '42' } });
    svc.emit('user-2', { type: 'timer.started', data: { id: '99' } }); // no subscriber — drops
    svc.emit('user-1', { type: 'timer.stopped' });

    expect(events).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((events[0] as any).type).toBe('timer.started');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((events[0] as any).data).toEqual({ id: '42' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((events[0] as any).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    sub.unsubscribe();
    unsubscribe();
    expect(svc.subscriberCount('user-1')).toBe(0);
  });

  it('multiple subscribers for the same user all receive events', () => {
    const svc = new SyncService();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const subA = svc.subscribe('u');
    const subB = svc.subscribe('u');
    subA.subject.subscribe((e) => a.push(e));
    subB.subject.subscribe((e) => b.push(e));
    svc.emit('u', { type: 'x' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it('events do not cross user boundaries', () => {
    const svc = new SyncService();
    const u1: unknown[] = [];
    const u2: unknown[] = [];
    const s1 = svc.subscribe('u1');
    const s2 = svc.subscribe('u2');
    s1.subject.subscribe((e) => u1.push(e));
    s2.subject.subscribe((e) => u2.push(e));
    svc.emit('u1', { type: 'private' });
    expect(u1).toHaveLength(1);
    expect(u2).toHaveLength(0);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('unsubscribe removes the subject; further emits do not deliver', () => {
    const svc = new SyncService();
    const events: unknown[] = [];
    const { subject, unsubscribe } = svc.subscribe('u');
    const sub = subject.subscribe((e) => events.push(e));
    svc.emit('u', { type: 'first' });
    unsubscribe();
    svc.emit('u', { type: 'second' });
    expect(events).toHaveLength(1);
    expect(svc.subscriberCount('u')).toBe(0);
    sub.unsubscribe();
  });

  it('onModuleDestroy drains all subjects', () => {
    const svc = new SyncService();
    const { subject, unsubscribe } = svc.subscribe('u');
    let completed = false;
    subject.subscribe({ complete: () => { completed = true; } });
    svc.onModuleDestroy();
    expect(completed).toBe(true);
    expect(svc.subscriberCount('u')).toBe(0);
    unsubscribe(); // idempotent
  });
});
