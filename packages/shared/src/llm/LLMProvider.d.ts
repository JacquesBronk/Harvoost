import { z, type ZodTypeAny } from 'zod';
import { type LLMProviderName, type ProviderCapability } from './capabilities.js';
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
export declare class MockLLMProvider implements LLMProvider {
    readonly provider: LLMProviderName;
    readonly model: string;
    private scriptedToolCalls;
    private scriptedReply;
    setScript(opts: {
        reply?: string;
        toolCalls?: Array<{
            name: string;
            input: unknown;
        }>;
    }): void;
    capabilities(): ProviderCapability;
    generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
    generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult>;
}
export declare class VercelAILLMProvider implements LLMProvider {
    readonly provider: LLMProviderName;
    readonly model: string;
    private readonly env;
    constructor(env: LLMEnv);
    capabilities(): ProviderCapability;
    generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
    generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult>;
    private loadAiModule;
    private buildModel;
}
export declare function createLLMProvider(env: LLMEnv): LLMProvider;
export { z };
//# sourceMappingURL=LLMProvider.d.ts.map