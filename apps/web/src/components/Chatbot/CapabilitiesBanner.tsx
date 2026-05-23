import { AlertTriangle } from 'lucide-react';
import type { ChatbotCapabilities } from '@/lib/api-types.js';

export function CapabilitiesBanner({ caps }: { caps: ChatbotCapabilities | undefined }) {
  if (!caps || caps.enabled) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-warning-500/30 bg-warning-50 px-4 py-3 text-sm text-warning-700"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">The assistant is currently unavailable.</p>
        <p className="text-xs">
          {caps.reason === 'tool_calling_not_supported_by_provider'
            ? `The configured LLM provider (${caps.provider}/${caps.model}) does not support tool calling. Contact your administrator.`
            : (caps.reason ?? 'Please contact your administrator.')}
        </p>
      </div>
    </div>
  );
}
