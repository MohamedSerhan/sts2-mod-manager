import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextType {
  toast: (message: string, type?: 'success' | 'error' | 'info') => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

const FADE_MS = 250;

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const ctx: ToastContextType = {
    toast: addToast,
    success: (msg) => addToast(msg, 'success'),
    error: (msg) => addToast(msg, 'error'),
    info: (msg) => addToast(msg, 'info'),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {/* Toast container */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 max-w-md pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={() => removeToast(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // `visible` drives the mount fade-in; `leaving` drives the dismiss fade-out.
  // We delay the actual unmount by FADE_MS so the exit transition has time to play.
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    const dismissAt = toast.type === 'error' ? 6000 : 4000;
    const dismissTimer = setTimeout(() => setLeaving(true), dismissAt);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(dismissTimer);
    };
  }, [toast.type]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDismiss, FADE_MS);
    return () => clearTimeout(t);
  }, [leaving, onDismiss]);

  const borderColor = {
    success: 'border-green-500/40',
    error: 'border-red-500/40',
    info: 'border-primary/40',
  }[toast.type];

  const textColor = {
    success: 'text-green-400',
    error: 'text-red-400',
    info: 'text-primary',
  }[toast.type];

  const shown = visible && !leaving;

  return (
    <div
      className={`bg-surface border ${borderColor} rounded-lg px-4 py-3 shadow-lg flex items-start gap-2 text-sm text-text transition-all duration-[250ms] ease-out ${
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <span className={`${textColor} flex-1`}>{toast.message}</span>
      <button
        onClick={() => setLeaving(true)}
        className="text-text-dim hover:text-text shrink-0 mt-0.5"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
