import { describe, it, expect, vi } from 'vitest';
import { chatbotPruneOldConversations } from '../chatbot-prune-old-conversations';
import type { JobDeps } from '../../types';

// In-memory Prisma stub that simulates DELETE WHERE last_message_at < NOW() - INTERVAL '30 days'.
function makeDeps(rows: Array<{ id: string; last_message_at: Date }>): {
  deps: JobDeps;
  rows: typeof rows;
  logs: Array<{ level: string; msg: string; meta?: unknown }>;
} {
  const logs: Array<{ level: string; msg: string; meta?: unknown }> = [];
  const deps: JobDeps = {
    prisma: {
      $queryRawUnsafe: vi.fn(async () => []) as unknown as JobDeps['prisma']['$queryRawUnsafe'],
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes('DELETE FROM chatbot_conversations')) {
          const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i]!.last_message_at.getTime() < cutoff) rows.splice(i, 1);
          }
          return before - rows.length;
        }
        return 0;
      }) as unknown as JobDeps['prisma']['$executeRawUnsafe'],
    },
    llm: {
      provider: 'mock',
      model: 'mock-test',
      capabilities: () => ({ supportsTools: true, supportsStreaming: false }),
      generateText: async () => ({ text: '', usage: { promptTokens: 0, completionTokens: 0 } }),
      generateWithTools: async () => ({ text: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } }),
    },
    mailer: { send: async () => ({ messageId: 'test' }) },
    logger: {
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    },
  };
  return { deps, rows, logs };
}

describe('chatbot.prune_old_conversations (ARCHITECTURE r2 § Persistence + retention)', () => {
  it('declares the documented cron (daily 03:00 UTC)', () => {
    expect(chatbotPruneOldConversations.cron).toBe('0 3 * * *');
    expect(chatbotPruneOldConversations.trigger).toBe('cron');
    expect(chatbotPruneOldConversations.name).toBe('chatbot.prune_old_conversations');
  });

  it('deletes conversations with last_message_at > 30 days ago, keeps fresher ones', async () => {
    const now = Date.now();
    const rows = [
      { id: 'conv-31d', last_message_at: new Date(now - 31 * 24 * 60 * 60 * 1000) },
      { id: 'conv-29d', last_message_at: new Date(now - 29 * 24 * 60 * 60 * 1000) },
      { id: 'conv-10d', last_message_at: new Date(now - 10 * 24 * 60 * 60 * 1000) },
    ];
    const { deps, rows: liveRows } = makeDeps(rows);
    await chatbotPruneOldConversations.handler(null, deps);
    const remaining = liveRows.map((r) => r.id);
    expect(remaining).toContain('conv-29d');
    expect(remaining).toContain('conv-10d');
    expect(remaining).not.toContain('conv-31d');
  });

  it('is idempotent — running twice deletes no new rows', async () => {
    const now = Date.now();
    const rows = [{ id: 'conv-31d', last_message_at: new Date(now - 31 * 24 * 60 * 60 * 1000) }];
    const { deps, rows: live } = makeDeps(rows);
    await chatbotPruneOldConversations.handler(null, deps);
    expect(live).toHaveLength(0);
    // Second run.
    await chatbotPruneOldConversations.handler(null, deps);
    expect(live).toHaveLength(0);
  });

  it('logs a success line including durationMs', async () => {
    const { deps, logs } = makeDeps([]);
    await chatbotPruneOldConversations.handler(null, deps);
    const ok = logs.find((l) => l.msg === 'chatbot.prune_old_conversations.ok');
    expect(ok).toBeDefined();
    expect(ok!.meta).toHaveProperty('durationMs');
  });
});
