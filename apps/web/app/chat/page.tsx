'use client';

import { PageHeader } from '@/components/PageHeader.js';
import { ChatPanel } from '@/components/Chatbot/ChatPanel.js';

export default function ChatPage() {
  return (
    <div>
      <PageHeader
        title="Assistant"
        description="Ask questions about your scoped data. Results are filtered to what you can already see in dashboards."
      />
      <ChatPanel />
    </div>
  );
}
