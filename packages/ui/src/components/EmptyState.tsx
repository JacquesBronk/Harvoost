import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../lib/cn.js';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-200 bg-neutral-50/50 px-6 py-10 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-neutral-400 shadow-sm">
        {icon ?? <Inbox className="h-5 w-5" aria-hidden="true" />}
      </div>
      <div className="max-w-sm">
        <div className="text-sm font-semibold text-neutral-900">{title}</div>
        {description ? (
          <div className="mt-1 text-xs text-neutral-500">{description}</div>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
