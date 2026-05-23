import { AppShell } from '@/components/AppShell.js';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
