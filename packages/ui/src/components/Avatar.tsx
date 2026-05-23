import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  /** Display name to derive initials from. May be undefined/empty while data loads. */
  name?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

export function initialsOf(name?: string | null): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase();
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return ((first + last) || '?').toUpperCase();
}

const sizeClasses = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
};

export const Avatar = forwardRef<HTMLDivElement, AvatarProps>(function Avatar(
  { name, size = 'md', className, ...rest },
  ref,
) {
  const label = name?.trim() ? name : 'User';
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800',
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {initialsOf(name)}
    </div>
  );
});
