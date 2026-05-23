import { describe, it, expect } from 'vitest';
import { createLLMProvider, MockLLMProvider, VercelAILLMProvider } from '../LLMProvider';
import { lookupCapability } from '../capabilities';

describe('createLLMProvider — multi-provider invariant', () => {
  it('returns a MockLLMProvider when LLM_PROVIDER=mock', () => {
    const p = createLLMProvider({ LLM_PROVIDER: 'mock', LLM_MODEL_ID: 'mock-test' });
    expect(p).toBeInstanceOf(MockLLMProvider);
  });

  it('throws LLMConfigError when openai is selected without OPENAI_API_KEY', () => {
    expect(() =>
      createLLMProvider({ LLM_PROVIDER: 'openai', LLM_MODEL_ID: 'gpt-4o' }),
    ).toThrow(/LLMConfigError.*OPENAI_API_KEY/);
  });

  it('throws when anthropic is selected without ANTHROPIC_API_KEY', () => {
    expect(() =>
      createLLMProvider({ LLM_PROVIDER: 'anthropic', LLM_MODEL_ID: 'claude-sonnet-4-5' }),
    ).toThrow(/LLMConfigError.*ANTHROPIC_API_KEY/);
  });

  it('throws when google is selected without GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(() =>
      createLLMProvider({ LLM_PROVIDER: 'google', LLM_MODEL_ID: 'gemini-1.5-pro' }),
    ).toThrow(/LLMConfigError.*GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it('throws when xai is selected without XAI_API_KEY', () => {
    expect(() => createLLMProvider({ LLM_PROVIDER: 'xai', LLM_MODEL_ID: 'grok-3' })).toThrow(
      /LLMConfigError.*XAI_API_KEY/,
    );
  });

  it('throws when ollama is selected without OLLAMA_BASE_URL', () => {
    expect(() => createLLMProvider({ LLM_PROVIDER: 'ollama', LLM_MODEL_ID: 'llama3.1' })).toThrow(
      /LLMConfigError.*OLLAMA_BASE_URL/,
    );
  });

  it('boots a VercelAILLMProvider when openai is selected with OPENAI_API_KEY', () => {
    const p = createLLMProvider({
      LLM_PROVIDER: 'openai',
      LLM_MODEL_ID: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(p).toBeInstanceOf(VercelAILLMProvider);
    expect(p.provider).toBe('openai');
    expect(p.model).toBe('gpt-4o');
  });
});

describe('MockLLMProvider behaviour', () => {
  it('reports mock capabilities (tools supported, streaming not)', () => {
    const p = new MockLLMProvider();
    const caps = p.capabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsStreaming).toBe(false);
  });

  it('returns scripted reply when set', async () => {
    const p = new MockLLMProvider();
    p.setScript({ reply: 'hello world' });
    const r = await p.generateText({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('hello world');
    expect(r.usage.promptTokens).toBeGreaterThanOrEqual(0);
  });

  it('executes scripted tool calls and returns their outputs', async () => {
    const p = new MockLLMProvider();
    let executed = false;
    p.setScript({
      reply: 'done',
      toolCalls: [{ name: 'mytool', input: { x: 1 } }],
    });
    const r = await p.generateWithTools({
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        mytool: {
          name: 'mytool',
          description: 'test',
          parameters: (await import('zod')).z.object({ x: (await import('zod')).z.number() }),
          execute: async (input: unknown) => {
            executed = true;
            return { ok: true, input };
          },
        },
      },
    });
    expect(executed).toBe(true);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.output).toEqual({ ok: true, input: { x: 1 } });
  });

  it('marks unknown scripted tool calls as errored', async () => {
    const p = new MockLLMProvider();
    p.setScript({ toolCalls: [{ name: 'doesnotexist', input: {} }] });
    const r = await p.generateWithTools({ messages: [], tools: {} });
    expect(r.toolCalls[0]!.errored).toBe(true);
  });
});

describe('lookupCapability — tool-calling matrix', () => {
  it('returns supportsTools=true for gpt-4o variants (canonical production)', () => {
    expect(lookupCapability('openai', 'gpt-4o').supportsTools).toBe(true);
    expect(lookupCapability('openai', 'gpt-4o-mini').supportsTools).toBe(true);
    expect(lookupCapability('openai', 'gpt-4.1').supportsTools).toBe(true);
  });

  it('returns supportsTools=true for the documented Anthropic, Google, xAI models', () => {
    expect(lookupCapability('anthropic', 'claude-sonnet-4-5').supportsTools).toBe(true);
    expect(lookupCapability('google', 'gemini-1.5-pro').supportsTools).toBe(true);
    expect(lookupCapability('xai', 'grok-3').supportsTools).toBe(true);
  });

  it('returns supportsTools=false for unknown Ollama models (chatbot must show disabled)', () => {
    // Per matrix: small local models like phi3, gemma2 are not in the supported list.
    expect(lookupCapability('ollama', 'phi3').supportsTools).toBe(false);
    expect(lookupCapability('ollama', 'gemma2').supportsTools).toBe(false);
  });

  it('returns supportsTools=true for whitelisted Ollama models', () => {
    expect(lookupCapability('ollama', 'llama3.1').supportsTools).toBe(true);
    expect(lookupCapability('ollama', 'qwen2.5').supportsTools).toBe(true);
    expect(lookupCapability('ollama', 'mistral-0.3').supportsTools).toBe(true);
  });

  it('mock provider reports supportsTools=true (used in tests)', () => {
    expect(lookupCapability('mock', 'mock-test').supportsTools).toBe(true);
  });
});
