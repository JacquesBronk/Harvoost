import { z, type ZodTypeAny } from 'zod';
import { lookupCapability, type LLMProviderName, type ProviderCapability } from './capabilities';

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  execute: (input: TInput) => Promise<TOutput>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  errored?: boolean;
}

export interface GenerateTextInput {
  messages: Msg[];
  system?: string;
  maxTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  usage: LLMUsage;
}

export interface GenerateWithToolsInput {
  messages: Msg[];
  tools: Record<string, ToolDef>;
  system?: string;
  maxTokens?: number;
  maxToolRoundtrips?: number;
}

export interface GenerateWithToolsResult {
  text: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
}

export interface LLMProvider {
  readonly provider: LLMProviderName;
  readonly model: string;
  capabilities(): ProviderCapability;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult>;
}

export interface LLMEnv {
  LLM_PROVIDER: LLMProviderName;
  LLM_MODEL_ID: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  XAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
}

// MockLLMProvider — used in unit + integration tests. Returns scripted responses
// keyed off a tiny rule set so RBAC tests can simulate tool-call sequences.
export class MockLLMProvider implements LLMProvider {
  public readonly provider: LLMProviderName = 'mock';
  public readonly model: string = 'mock-test';
  // Hook test scenarios can register; default behaves as a pass-through echo.
  private scriptedToolCalls: Array<{ name: string; input: unknown }> = [];
  private scriptedReply = 'Mock reply.';

  setScript(opts: { reply?: string; toolCalls?: Array<{ name: string; input: unknown }> }): void {
    if (opts.reply !== undefined) this.scriptedReply = opts.reply;
    if (opts.toolCalls !== undefined) this.scriptedToolCalls = opts.toolCalls;
  }

  capabilities(): ProviderCapability {
    return lookupCapability('mock', 'mock-test');
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return {
      text: this.scriptedReply || `mock(${input.messages.length} msgs)`,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }

  async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
    const toolCalls: ToolCall[] = [];
    for (const sc of this.scriptedToolCalls) {
      const tool = input.tools[sc.name];
      if (!tool) {
        toolCalls.push({ id: `mock-${toolCalls.length}`, name: sc.name, input: sc.input, errored: true });
        continue;
      }
      try {
        const parsed = tool.parameters.parse(sc.input);
        const output = await tool.execute(parsed);
        toolCalls.push({ id: `mock-${toolCalls.length}`, name: sc.name, input: parsed, output });
      } catch (err) {
        toolCalls.push({
          id: `mock-${toolCalls.length}`,
          name: sc.name,
          input: sc.input,
          output: { error: err instanceof Error ? err.message : String(err) },
          errored: true,
        });
      }
    }
    return {
      text: this.scriptedReply,
      toolCalls,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }
}

// VercelAILLMProvider — the production implementation, lazily-imports the
// `ai` SDK and the per-provider plug-ins so this shared package can be built
// without those packages installed (kept optional).
//
// We construct a thin shim rather than a Vercel-AI-SDK-direct dependency in
// `@harvoost/shared` so the package can be consumed from packages that don't
// want the SDK pulled in (e.g., for type-only imports during testing).
export class VercelAILLMProvider implements LLMProvider {
  public readonly provider: LLMProviderName;
  public readonly model: string;
  private readonly env: LLMEnv;

  constructor(env: LLMEnv) {
    this.provider = env.LLM_PROVIDER;
    this.model = env.LLM_MODEL_ID;
    this.env = env;
  }

  capabilities(): ProviderCapability {
    return lookupCapability(this.provider, this.model);
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const ai = await this.loadAiModule();
    const model = await this.buildModel();
    const result = await ai.generateText({
      model,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: input.maxTokens ?? 1024,
    });
    return {
      text: result.text ?? '',
      usage: {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      },
    };
  }

  async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
    const ai = await this.loadAiModule();
    const model = await this.buildModel();
    // Translate our ToolDef to Vercel AI SDK's tool() shape.
    const tools: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(input.tools)) {
      tools[name] = ai.tool({
        description: t.description,
        parameters: t.parameters,
        execute: t.execute,
      });
    }
    const result = await ai.generateText({
      model,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools,
      maxToolRoundtrips: input.maxToolRoundtrips ?? 4,
      maxTokens: input.maxTokens ?? 1024,
    });
    const rawToolCalls = (result.toolCalls ?? []) as Array<{ toolCallId: string; toolName: string; args: unknown }>;
    const toolCalls: ToolCall[] = rawToolCalls.map((tc, idx) => ({
      id: tc.toolCallId ?? `call-${idx}`,
      name: tc.toolName,
      input: tc.args,
    }));
    const toolResults = result.toolResults ?? [];
    for (let i = 0; i < toolResults.length; i++) {
      const tr = toolResults[i] as { toolCallId?: string; result?: unknown };
      const match = toolCalls.find((c) => c.id === tr.toolCallId);
      if (match) match.output = tr.result;
    }
    return {
      text: result.text ?? '',
      toolCalls,
      usage: {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      },
    };
  }

  // Dynamic imports — keep optional deps optional.
  private async loadAiModule(): Promise<{
    generateText: (opts: unknown) => Promise<{
      text?: string;
      toolCalls?: unknown[];
      toolResults?: unknown[];
      usage?: { promptTokens?: number; completionTokens?: number };
    }>;
    tool: (def: unknown) => unknown;
  }> {
    // The actual `ai` package surface is bigger; we narrow to what we use.
    // The typed import is `any` because the dep is optional in this shared package.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('ai').catch((err) => {
      throw new Error(`Vercel AI SDK not installed in this environment: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { generateText: mod.generateText, tool: mod.tool };
  }

  // Resolve the per-provider model factory; each is dynamically imported so a
  // missing optional dep doesn't break boot.
  private async buildModel(): Promise<unknown> {
    switch (this.provider) {
      case 'openai': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('@ai-sdk/openai');
        return mod.openai(this.model);
      }
      case 'anthropic': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('@ai-sdk/anthropic');
        return mod.anthropic(this.model);
      }
      case 'google': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('@ai-sdk/google');
        return mod.google(this.model);
      }
      case 'xai': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('@ai-sdk/xai');
        return mod.xai(this.model);
      }
      case 'ollama': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('ollama-ai-provider');
        return mod.ollama(this.model);
      }
      case 'mock':
        throw new Error('MockLLMProvider should be constructed directly, not via VercelAILLMProvider');
      default:
        throw new Error(`Unsupported LLM_PROVIDER: ${String(this.provider)}`);
    }
  }
}

// Single boot-time factory. Validates the multi-provider invariant: exactly one key set for the active provider.
export function createLLMProvider(env: LLMEnv): LLMProvider {
  if (env.LLM_PROVIDER === 'mock') {
    return new MockLLMProvider();
  }
  const required: Record<Exclude<LLMProviderName, 'mock'>, keyof LLMEnv> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    xai: 'XAI_API_KEY',
    ollama: 'OLLAMA_BASE_URL',
  };
  const expectedKey = required[env.LLM_PROVIDER];
  if (!env[expectedKey]) {
    throw new Error(`LLMConfigError: LLM_PROVIDER=${env.LLM_PROVIDER} requires ${expectedKey} to be set.`);
  }
  return new VercelAILLMProvider(env);
}

// Zod helper re-export so chatbot tools can compose schemas.
export { z };
