"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.z = exports.VercelAILLMProvider = exports.MockLLMProvider = void 0;
exports.createLLMProvider = createLLMProvider;
const zod_1 = require("zod");
Object.defineProperty(exports, "z", { enumerable: true, get: function () { return zod_1.z; } });
const capabilities_js_1 = require("./capabilities.js");
// MockLLMProvider — used in unit + integration tests. Returns scripted responses
// keyed off a tiny rule set so RBAC tests can simulate tool-call sequences.
class MockLLMProvider {
    constructor() {
        this.provider = 'mock';
        this.model = 'mock-test';
        // Hook test scenarios can register; default behaves as a pass-through echo.
        this.scriptedToolCalls = [];
        this.scriptedReply = 'Mock reply.';
    }
    setScript(opts) {
        if (opts.reply !== undefined)
            this.scriptedReply = opts.reply;
        if (opts.toolCalls !== undefined)
            this.scriptedToolCalls = opts.toolCalls;
    }
    capabilities() {
        return (0, capabilities_js_1.lookupCapability)('mock', 'mock-test');
    }
    async generateText(input) {
        return {
            text: this.scriptedReply || `mock(${input.messages.length} msgs)`,
            usage: { promptTokens: 1, completionTokens: 1 },
        };
    }
    async generateWithTools(input) {
        const toolCalls = [];
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
            }
            catch (err) {
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
exports.MockLLMProvider = MockLLMProvider;
// VercelAILLMProvider — the production implementation, lazily-imports the
// `ai` SDK and the per-provider plug-ins so this shared package can be built
// without those packages installed (kept optional).
//
// We construct a thin shim rather than a Vercel-AI-SDK-direct dependency in
// `@harvoost/shared` so the package can be consumed from packages that don't
// want the SDK pulled in (e.g., for type-only imports during testing).
class VercelAILLMProvider {
    constructor(env) {
        this.provider = env.LLM_PROVIDER;
        this.model = env.LLM_MODEL_ID;
        this.env = env;
    }
    capabilities() {
        return (0, capabilities_js_1.lookupCapability)(this.provider, this.model);
    }
    async generateText(input) {
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
    async generateWithTools(input) {
        const ai = await this.loadAiModule();
        const model = await this.buildModel();
        // Translate our ToolDef to Vercel AI SDK's tool() shape.
        const tools = {};
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
        const rawToolCalls = (result.toolCalls ?? []);
        const toolCalls = rawToolCalls.map((tc, idx) => ({
            id: tc.toolCallId ?? `call-${idx}`,
            name: tc.toolName,
            input: tc.args,
        }));
        const toolResults = result.toolResults ?? [];
        for (let i = 0; i < toolResults.length; i++) {
            const tr = toolResults[i];
            const match = toolCalls.find((c) => c.id === tr.toolCallId);
            if (match)
                match.output = tr.result;
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
    async loadAiModule() {
        // The actual `ai` package surface is bigger; we narrow to what we use.
        // The typed import is `any` because the dep is optional in this shared package.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await Promise.resolve().then(() => __importStar(require('ai'))).catch((err) => {
            throw new Error(`Vercel AI SDK not installed in this environment: ${err instanceof Error ? err.message : String(err)}`);
        });
        return { generateText: mod.generateText, tool: mod.tool };
    }
    // Resolve the per-provider model factory; each is dynamically imported so a
    // missing optional dep doesn't break boot.
    async buildModel() {
        switch (this.provider) {
            case 'openai': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await Promise.resolve().then(() => __importStar(require('@ai-sdk/openai')));
                return mod.openai(this.model);
            }
            case 'anthropic': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await Promise.resolve().then(() => __importStar(require('@ai-sdk/anthropic')));
                return mod.anthropic(this.model);
            }
            case 'google': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await Promise.resolve().then(() => __importStar(require('@ai-sdk/google')));
                return mod.google(this.model);
            }
            case 'xai': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await Promise.resolve().then(() => __importStar(require('@ai-sdk/xai')));
                return mod.xai(this.model);
            }
            case 'ollama': {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await Promise.resolve().then(() => __importStar(require('ollama-ai-provider')));
                return mod.ollama(this.model);
            }
            case 'mock':
                throw new Error('MockLLMProvider should be constructed directly, not via VercelAILLMProvider');
            default:
                throw new Error(`Unsupported LLM_PROVIDER: ${String(this.provider)}`);
        }
    }
}
exports.VercelAILLMProvider = VercelAILLMProvider;
// Single boot-time factory. Validates the multi-provider invariant: exactly one key set for the active provider.
function createLLMProvider(env) {
    if (env.LLM_PROVIDER === 'mock') {
        return new MockLLMProvider();
    }
    const required = {
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
//# sourceMappingURL=LLMProvider.js.map