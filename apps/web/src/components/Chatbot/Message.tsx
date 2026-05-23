import { Bot, User } from 'lucide-react';
import { cn } from '@harvoost/ui';
import type { ChatbotMessage } from '@/lib/api-types.js';

export function MessageBubble({ message }: { message: ChatbotMessage }) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  if (isTool) {
    // Render a compact "tool used" line, not a chat bubble.
    return (
      <div className="px-2 py-1 text-xs text-neutral-500">
        <span className="font-mono">{message.tool_name}</span>
        {message.tool_input
          ? ` · ${JSON.stringify(message.tool_input).slice(0, 80)}`
          : ''}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-2 py-1.5',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      {!isUser ? (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <Bot className="h-4 w-4" aria-hidden="true" />
        </div>
      ) : null}
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-brand-600 text-white'
            : 'border border-neutral-200 bg-white text-neutral-900',
        )}
      >
        {message.content ?? ''}
      </div>
      {isUser ? (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-neutral-700">
          <User className="h-4 w-4" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}
