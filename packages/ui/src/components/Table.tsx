import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn.js';

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-md border border-neutral-200">
      <table
        className={cn('w-full border-collapse text-left text-sm', className)}
        {...rest}
      />
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500', className)}
      {...rest}
    />
  );
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-neutral-100', className)} {...rest} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('hover:bg-neutral-50/50 transition-colors', className)} {...rest} />
  );
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn('px-3 py-2 font-medium text-neutral-600', className)}
      {...rest}
    />
  );
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2 text-neutral-800', className)} {...rest} />;
}

export type SortDirection = 'asc' | 'desc' | null;

export interface SortableTHProps extends ThHTMLAttributes<HTMLTableCellElement> {
  active?: boolean;
  direction?: SortDirection;
  onSort?: () => void;
  children: ReactNode;
}

export function SortableTH({
  active,
  direction,
  onSort,
  children,
  className,
  ...rest
}: SortableTHProps) {
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const Icon = active ? (direction === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn('px-3 py-2 font-medium text-neutral-600', className)}
      {...rest}
    >
      <button
        type="button"
        onClick={onSort}
        className="inline-flex items-center gap-1 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:rounded"
      >
        {children}
        <Icon aria-hidden="true" className="h-3 w-3" />
      </button>
    </th>
  );
}
