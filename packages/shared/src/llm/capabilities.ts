// Tool-calling capability matrix per ARCHITECTURE.md § Chatbot architecture § Tool-calling compatibility per provider.
// Lookup is (provider, modelPrefix) — modelPrefix matches the START of LLM_MODEL_ID.

export type LLMProviderName = 'openai' | 'anthropic' | 'google' | 'xai' | 'ollama' | 'mock';

export interface ProviderCapability {
  supportsTools: boolean;
  supportsStreaming: boolean;
}

interface CapEntry {
  provider: LLMProviderName;
  modelPrefix: string;
  caps: ProviderCapability;
}

const TABLE: CapEntry[] = [
  // OpenAI — canonical production provider (r2).
  { provider: 'openai', modelPrefix: 'gpt-4o', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'openai', modelPrefix: 'gpt-4.1', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'openai', modelPrefix: 'gpt-4-turbo', caps: { supportsTools: true, supportsStreaming: true } },
  // Anthropic.
  { provider: 'anthropic', modelPrefix: 'claude-sonnet-4', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'anthropic', modelPrefix: 'claude-sonnet-4-5', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'anthropic', modelPrefix: 'claude-haiku', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'anthropic', modelPrefix: 'claude-opus', caps: { supportsTools: true, supportsStreaming: true } },
  // Google.
  { provider: 'google', modelPrefix: 'gemini-1.5', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'google', modelPrefix: 'gemini-2.0', caps: { supportsTools: true, supportsStreaming: true } },
  // xAI.
  { provider: 'xai', modelPrefix: 'grok-2', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'xai', modelPrefix: 'grok-3', caps: { supportsTools: true, supportsStreaming: true } },
  // Ollama — model-dependent, default to no tool support unless explicitly listed.
  { provider: 'ollama', modelPrefix: 'llama3.1', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'ollama', modelPrefix: 'qwen2.5', caps: { supportsTools: true, supportsStreaming: true } },
  { provider: 'ollama', modelPrefix: 'mistral', caps: { supportsTools: true, supportsStreaming: true } },
  // Mock provider — used in tests.
  { provider: 'mock', modelPrefix: 'mock', caps: { supportsTools: true, supportsStreaming: false } },
];

export function lookupCapability(provider: LLMProviderName, modelId: string): ProviderCapability {
  const match = TABLE.find((e) => e.provider === provider && modelId.toLowerCase().startsWith(e.modelPrefix));
  if (match) return match.caps;
  // Default: unknown ollama models do NOT support tools.
  if (provider === 'ollama') {
    return { supportsTools: false, supportsStreaming: true };
  }
  // Default for hosted providers: assume tools work, fail open. (Better to surface 503 at call time than block boot.)
  return { supportsTools: true, supportsStreaming: true };
}
