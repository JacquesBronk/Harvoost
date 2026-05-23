import type { RbacScopeService } from '../rbac/RbacScopeService.js';
import type { ToolDef } from './LLMProvider.js';
export interface ChatbotPrismaLike {
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export type ChatbotToolFactory = (requesterId: string, prisma: ChatbotPrismaLike, rbac: RbacScopeService) => ToolDef;
export declare const getUserHoursTool: ChatbotToolFactory;
export declare const listMyProjectsTool: ChatbotToolFactory;
export declare const projectRollupTool: ChatbotToolFactory;
export declare const listExceptionsTool: ChatbotToolFactory;
export declare const teamSummaryTool: ChatbotToolFactory;
export declare const topBillableProjectsTool: ChatbotToolFactory;
export declare const findUserByNameTool: ChatbotToolFactory;
export declare const findProjectByNameTool: ChatbotToolFactory;
export declare const getUserScheduleTool: ChatbotToolFactory;
export declare const listOvertimeTool: ChatbotToolFactory;
export declare const moodTrendTool: ChatbotToolFactory;
export declare const orgUtilisationTool: ChatbotToolFactory;
export declare const whoIsClockedInTool: ChatbotToolFactory;
export declare function buildChatbotTools(requesterId: string, prisma: ChatbotPrismaLike, rbac: RbacScopeService): Record<string, ToolDef>;
//# sourceMappingURL=chatbot-tools.d.ts.map