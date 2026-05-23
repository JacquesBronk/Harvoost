'use client';

import { useId, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn.js';

// Five happy-face glyphs. SVG inline so the picker has no external asset dependency.
// Order: 1 (very low) → 5 (very high).

export interface MoodPickerProps {
  value?: number | null;
  onChange?: (score: 1 | 2 | 3 | 4 | 5) => void;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

const moodMeta: Array<{ score: 1 | 2 | 3 | 4 | 5; label: string; emoji: string }> = [
  { score: 1, label: 'Very low', emoji: '\u{1F614}' },
  { score: 2, label: 'Low', emoji: '\u{1F615}' },
  { score: 3, label: 'Okay', emoji: '\u{1F642}' },
  { score: 4, label: 'Good', emoji: '\u{1F60A}' },
  { score: 5, label: 'Excellent', emoji: '\u{1F604}' },
];

const sizeClasses = {
  sm: 'h-8 w-8 text-base',
  md: 'h-10 w-10 text-xl',
  lg: 'h-14 w-14 text-3xl',
};

export function MoodPicker({
  value,
  onChange,
  disabled,
  label = 'How are you feeling?',
  size = 'md',
}: MoodPickerProps) {
  const groupId = useId();

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, currentScore: number) {
    if (disabled || !onChange) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      const next = Math.min(5, currentScore + 1);
      onChange(next as 1 | 2 | 3 | 4 | 5);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      const next = Math.max(1, currentScore - 1);
      onChange(next as 1 | 2 | 3 | 4 | 5);
      e.preventDefault();
    }
  }

  return (
    <div role="radiogroup" aria-label={label} aria-labelledby={groupId}>
      <div id={groupId} className="mb-2 text-sm font-medium text-neutral-700">
        {label}
      </div>
      <div className="flex items-center gap-2">
        {moodMeta.map((m) => {
          const selected = value === m.score;
          return (
            <button
              key={m.score}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={m.label}
              tabIndex={selected || (!value && m.score === 3) ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange?.(m.score)}
              onKeyDown={(e) => handleKeyDown(e, m.score)}
              className={cn(
                'flex items-center justify-center rounded-full border transition-all',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                'disabled:cursor-not-allowed disabled:opacity-50',
                sizeClasses[size],
                selected
                  ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/40 scale-110'
                  : 'border-neutral-200 bg-white hover:border-neutral-400 hover:bg-neutral-50',
              )}
            >
              <span aria-hidden="true">{m.emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
