'use client';

import { MessageSquare, Plus } from 'lucide-react';
import { Button } from '@harvoost/ui';
import { DateTime } from 'luxon';
import type { ChatbotConversation } from '@/lib/api-types.js';

interface Props {
  conversations: ChatbotConversation[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  loading?: boolean;
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  loading,
}: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Conversations
        </span>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          onClick={onNew}
        >
          New
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {loading ? (
          <li className="px-3 py-4 text-xs text-neutral-500">Loading…</li>
        ) : conversations.length === 0 ? (
          <li className="px-3 py-4 text-xs text-neutral-500">
            No conversations yet. Ask a question to get started.
          </li>
        ) : (
          conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  activeId === c.id ? 'bg-brand-50 text-brand-700' : 'text-neutral-700'
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {c.title ?? 'Untitled conversation'}
                </span>
                <span className="text-[10px] text-neutral-400">
                  {DateTime.fromISO(c.last_message_at).toRelative()}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
