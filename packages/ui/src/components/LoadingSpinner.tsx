import { cn } from '../lib/cn.js';

export interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

const sizeClasses = {
  sm: 'h-3.5 w-3.5 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[3px]',
};

export function LoadingSpinner({ size = 'md', label = 'Loading', className }: LoadingSpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-2 text-neutral-500', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block animate-spin rounded-full border-neutral-300 border-t-brand-600',
          sizeClasses[size],
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
