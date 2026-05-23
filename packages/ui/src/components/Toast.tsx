'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { X, AlertCircle, CheckCircle2, Info, AlertTriangle } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  show(input: Omit<ToastItem, 'id'>): void;
  info(title: string, description?: string): void;
  success(title: string, description?: string): void;
  warning(title: string, description?: string): void;
  error(title: string, description?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const toneClasses: Record<ToastTone, string> = {
  info: 'border-info-500/40 bg-info-50 text-info-700',
  success: 'border-success-500/40 bg-success-50 text-success-700',
  warning: 'border-warning-500/40 bg-warning-50 text-warning-700',
  danger: 'border-danger-500/40 bg-danger-50 text-danger-700',
};

const toneIcons: Record<ToastTone, ReactNode> = {
  info: <Info className="h-4 w-4" aria-hidden="true" />,
  success: <CheckCircle2 className="h-4 w-4" aria-hidden="true" />,
  warning: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
  danger: <AlertCircle className="h-4 w-4" aria-hidden="true" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => {
      const show = (input: Omit<ToastItem, 'id'>) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setItems((prev) => [...prev, { ...input, id }]);
      };
      return {
        show,
        info: (title, description) => show({ title, description, tone: 'info' }),
        success: (title, description) => show({ title, description, tone: 'success' }),
        warning: (title, description) => show({ title, description, tone: 'warning' }),
        error: (title, description) => show({ title, description, tone: 'danger' }),
      };
    },
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border bg-white px-4 py-3 shadow-popover',
              'data-[state=open]:animate-slide-up',
              toneClasses[item.tone],
            )}
          >
            <div className="mt-0.5 shrink-0">{toneIcons[item.tone]}</div>
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="text-sm font-semibold">
                {item.title}
              </ToastPrimitive.Title>
              {item.description ? (
                <ToastPrimitive.Description className="mt-0.5 text-xs opacity-90">
                  {item.description}
                </ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label="Close"
              className="ml-2 rounded p-1 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

// Low-level escape hatch for callers that need direct Radix primitives.
export const ToastRoot = forwardRef<
  HTMLLIElement,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Root>
>(function ToastRoot({ className, ...rest }, ref) {
  return <ToastPrimitive.Root ref={ref} className={cn(className)} {...rest} />;
});
