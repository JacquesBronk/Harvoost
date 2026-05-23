import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 border-neutral-200',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
  success: 'bg-success-50 text-success-700 border-success-500/30',
  warning: 'bg-warning-50 text-warning-700 border-warning-500/30',
  danger: 'bg-danger-50 text-danger-700 border-danger-500/30',
  info: 'bg-info-50 text-info-700 border-info-500/30',
};

const dotToneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-500',
  brand: 'bg-brand-500',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger-500',
  info: 'bg-info-500',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', dot, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        toneClasses[tone],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn('inline-block h-1.5 w-1.5 rounded-full', dotToneClasses[tone])}
        />
      ) : null}
      {children}
    </span>
  );
});

/**
 * Status pill specifically for the timesheet state machine.
 * Maps each canonical status to a tone and label.
 */
export function TimesheetStatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    draft: { tone: 'neutral', label: 'Draft' },
    running: { tone: 'brand', label: 'Running' },
    submitted: { tone: 'info', label: 'Submitted' },
    manager_approved: { tone: 'warning', label: 'Manager approved' },
    final_approved: { tone: 'success', label: 'Final approved' },
    rejected: { tone: 'danger', label: 'Rejected' },
  };
  const meta = map[status] ?? { tone: 'neutral' as BadgeTone, label: status };
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}
