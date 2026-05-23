import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, subtitle, actions, padded = true, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-neutral-200 bg-white shadow-card',
        className,
      )}
      {...rest}
    >
      {title || subtitle || actions ? (
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-4 py-3">
          <div className="min-w-0">
            {title ? (
              <div className="text-sm font-semibold text-neutral-900">{title}</div>
            ) : null}
            {subtitle ? (
              <div className="text-xs text-neutral-500">{subtitle}</div>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </div>
  );
});
