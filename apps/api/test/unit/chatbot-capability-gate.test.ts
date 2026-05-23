import { describe, it, expect, vi } from 'vitest';
import { ChatbotController } from '../../src/chatbot/chatbot.controller';
import { ChatbotDisabledError, MockLLMProvider, type LLMProvider } from '@harvoost/shared';

// Build a stub LLM provider that returns supportsTools=false to assert
// the capability gate raises CHATBOT_DISABLED 503.
function makeDisabledProvider(): LLMProvider {
  return {
    provider: 'ollama',
    model: 'phi3',
    capabilities: () => ({ supportsTools: false, supportsStreaming: true }),
    generateText: async () => ({ text: '', usage: { promptTokens: 0, completionTokens: 0 } }),
    generateWithTools: async () => {
      throw new Error('should not be called when capability gate is closed');
    },
  };
}

function makeEnabledProvider(): LLMProvider {
  return new MockLLMProvider();
}

const stubPrisma = {
  $queryRawUnsafe: vi.fn(async () => []),
  $executeRawUnsafe: vi.fn(async () => 1),
};

const stubRbac = {
  getVisibleUserIds: vi.fn(async () => ({ userIds: ['u'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true })),
  getVisibleProjectIds: vi.fn(async () => ({ projectIds: [], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true })),
} as unknown as ConstructorParameters<typeof ChatbotController>[1];

describe('Chatbot capability gate (ARCHITECTURE § Chatbot disabled fallback)', () => {
  it('GET /v1/chatbot/capabilities reports enabled=true for mock provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(stubPrisma as any, stubRbac, makeEnabledProvider());
    const caps = ctrl.capabilities();
    expect(caps.enabled).toBe(true);
    expect(caps.provider).toBe('mock');
    expect(caps.reason).toBeNull();
  });

  it('GET /v1/chatbot/capabilities reports enabled=false + reason for tool-incapable provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(stubPrisma as any, stubRbac, makeDisabledProvider());
    const caps = ctrl.capabilities();
    expect(caps.enabled).toBe(false);
    expect(caps.reason).toBe('tool_calling_not_supported_by_provider');
    expect(caps.provider).toBe('ollama');
    expect(caps.model).toBe('phi3');
  });

  it('POST /v1/chatbot/messages throws CHATBOT_DISABLED when provider lacks tool calling', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(stubPrisma as any, stubRbac, makeDisabledProvider());
    const user = { userId: '101', email: 'a@h.local', roles: ['employee'] };
    await expect(
      ctrl.postMessage(user, { conversation_id: undefined, message: 'hi' }),
    ).rejects.toBeInstanceOf(ChatbotDisabledError);
  });

  it('CHATBOT_DISABLED includes provider and model in the error details', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(stubPrisma as any, stubRbac, makeDisabledProvider());
    const user = { userId: '101', email: 'a@h.local', roles: ['employee'] };
    try {
      await ctrl.postMessage(user, { conversation_id: undefined, message: 'hi' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatbotDisabledError);
      const e = err as ChatbotDisabledError;
      expect(e.httpStatus).toBe(503);
      expect(e.code).toBe('CHATBOT_DISABLED');
      expect(e.details).toMatchObject({ provider: 'ollama', model: 'phi3' });
    }
  });
});

describe('Chatbot conversation ownership (ARCHITECTURE § Conversation ownership)', () => {
  it('GET /v1/chatbot/conversations/:id/messages returns 404 when not the owner (uniform with non-existent)', async () => {
    const prismaMock = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT user_id FROM chatbot_conversations')) {
          // Conversation exists, owned by user 999, but requester is 101.
          return [{ user_id: '999' }];
        }
        return [];
      }),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(prismaMock as any, stubRbac, makeEnabledProvider());
    const user = { userId: '101', email: 'a@h.local', roles: ['manager'] };
    await expect(ctrl.getMessages(user, 'some-conv-id')).rejects.toThrow();
    // Verify it's a NOT_FOUND-coded error (404), NOT 403, to avoid existence-leak.
    try {
      await ctrl.getMessages(user, 'some-conv-id');
    } catch (err) {
      const e = err as { code?: string; httpStatus?: number };
      expect(e.code).toBe('NOT_FOUND');
      expect(e.httpStatus).toBe(404);
    }
  });

  it('GET /v1/chatbot/conversations/:id/messages returns 404 when conversation does not exist', async () => {
    const prismaMock = {
      $queryRawUnsafe: vi.fn(async () => []),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(prismaMock as any, stubRbac, makeEnabledProvider());
    const user = { userId: '101', email: 'a@h.local', roles: ['admin'] };
    await expect(ctrl.getMessages(user, 'ghost-id')).rejects.toThrow();
  });

  it('GET /v1/chatbot/conversations always filters by requester user_id (own-only)', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const prismaMock = {
      $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
        calls.push({ sql, values });
        return [];
      }),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ChatbotController(prismaMock as any, stubRbac, makeEnabledProvider());
    // Even when requester is admin, the conversation list must be filtered by their own user_id.
    const admin = { userId: '999', email: 'admin@h.local', roles: ['admin'] };
    await ctrl.listConversations(admin, '50');
    const listCall = calls.find((c) => c.sql.includes('FROM chatbot_conversations'));
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toMatch(/WHERE user_id = \$1/);
    expect(listCall!.values[0]).toBe('999');
  });
});
