export type LLMProviderName = 'openai' | 'anthropic' | 'google' | 'xai' | 'ollama' | 'mock';
export interface ProviderCapability {
    supportsTools: boolean;
    supportsStreaming: boolean;
}
export declare function lookupCapability(provider: LLMProviderName, modelId: string): ProviderCapability;
//# sourceMappingURL=capabilities.d.ts.map