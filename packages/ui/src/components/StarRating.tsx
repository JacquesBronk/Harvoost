import { Star } from 'lucide-react';
import { cn } from '../lib/cn.js';

export interface StarRatingProps {
  value: number;
  max?: number;
  label?: string;
  size?: 'sm' | 'md';
}

// Display-only star rating. Used for compact representations
// of mood aggregates or similar 1..N scores.
export function StarRating({ value, max = 5, label, size = 'sm' }: StarRatingProps) {
  const stars = Array.from({ length: max }, (_, i) => i + 1);
  const dim = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <span
      role="img"
      aria-label={label ?? `Rating: ${value} out of ${max}`}
      className="inline-flex items-center gap-0.5"
    >
      {stars.map((s) => (
        <Star
          key={s}
          aria-hidden="true"
          className={cn(
            dim,
            s <= value ? 'fill-brand-500 text-brand-500' : 'fill-none text-neutral-300',
          )}
        />
      ))}
    </span>
  );
}
