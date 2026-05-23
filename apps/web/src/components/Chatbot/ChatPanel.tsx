'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, LoadingSpinner, useToast } from '@harvoost/ui';
import { apiFetch, describeError } from '@/lib/api-client.js';
import type {
  ChatbotCapabilities,
  ChatbotConversation,
  ChatbotMessage,
  ChatbotSendResponse,
  Paginated,
} from '@/lib/api-types.js';
import { CapabilitiesBanner } from './CapabilitiesBanner.js';
import { ConversationList } from './ConversationList.js';
import { MessageBubble } from './Message.js';

export function ChatPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const capabilities = useQuery({
    queryKey: ['chatbot', 'capabilities'],
    queryFn: () => apiFetch<ChatbotCapabilities>('/v1/chatbot/capabilities'),
    staleTime: 5 * 60_000,
  });

  const conversations = useQuery({
    queryKey: ['chatbot', 'conversations'],
    queryFn: () =>
      apiFetch<Paginated<ChatbotConversation>>('/v1/chatbot/conversations', {
        query: { limit: 50 },
      }),
  });

  const messages = useQuery({
    queryKey: ['chatbot', 'messages', activeId],
    queryFn: () =>
      apiFetch<Paginated<ChatbotMessage>>(
        `/v1/chatbot/conversations/${activeId}/messages`,
      ),
    enabled: !!activeId,
  });

  const sendMessage = useMutation({
    mutationFn: (message: string) =>
      apiFetch<ChatbotSendResponse>('/v1/chatbot/messages', {
        method: 'POST',
        body: { conversation_id: activeId, message },
      }),
    onSuccess: (response) => {
      setActiveId(response.conversation_id);
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['chatbot', 'conversations'] });
      queryClient.invalidateQueries({
        queryKey: ['chatbot', 'messages', response.conversation_id],
      });
    },
    onError: (err) => {
      toast.error('Could not send', describeError(err));
    },
  });

  const enabled = capabilities.data?.enabled ?? true;

  // Auto-scroll on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.data, sendMessage.isPending]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !enabled || sendMessage.isPending) return;
    sendMessage.mutate(text);
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="grid h-[calc(100vh-9rem)] grid-cols-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card lg:grid-cols-[260px_1fr]">
      <div className="hidden border-r border-neutral-100 lg:block">
        <ConversationList
          conversations={conversations.data?.items ?? []}
          activeId={activeId}
          loading={conversations.isLoading}
          onSelect={setActiveId}
          onNew={() => {
            setActiveId(null);
            inputRef.current?.focus();
          }}
        />
      </div>
      <div className="flex flex-col">
        <CapabilitiesBanner caps={capabilities.data} />
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto bg-neutral-50/30"
          aria-live="polite"
        >
          {messages.isLoading && activeId ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="md" label="Loading conversation" />
            </div>
          ) : !activeId ? (
            <div className="flex h-full items-center justify-center px-4">
              <EmptyState
                title="Ask me anything about your team's data"
                description="Try: 'How many hours did Alice work last week?', 'Show me overtime exceptions for my team.', 'Which of my projects went over budget last month?'"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1 py-2">
              {(messages.data?.items ?? []).map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {sendMessage.isPending ? (
                <div className="px-4 py-2 text-xs text-neutral-500">
                  Assistant is thinking…
                </div>
              ) : null}
            </div>
          )}
        </div>
        <form
          onSubmit={handleSubmit}
          className="border-t border-neutral-100 bg-white p-3"
          aria-label="Send a message to the assistant"
        >
          <div className="flex items-end gap-2">
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              disabled={!enabled || sendMessage.isPending}
              rows={1}
              placeholder={
                enabled
                  ? 'Ask about hours, exceptions, projects…'
                  : 'Assistant is disabled.'
              }
              className="min-h-9 max-h-32 flex-1 resize-none rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:bg-neutral-50"
            />
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={sendMessage.isPending}
              disabled={!draft.trim() || !enabled}
              iconLeft={<Send className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Send
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
