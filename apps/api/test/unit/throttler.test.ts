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

function readNamedLimiter(target: object, name: string): { limit?: number; ttl?: number } {
  return {
    limit: Reflect.getMetadata(`${THROTTLER_LIMIT}${name}`, target) as number | undefined,
    ttl: Reflect.getMetadata(`${THROTTLER_TTL}${name}`, target) as number | undefined,
  };
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
