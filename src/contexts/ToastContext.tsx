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
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.type === 'error' ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.type]);

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

  return (
    <div
      className={`bg-surface border ${borderColor} rounded-lg px-4 py-3 shadow-lg flex items-start gap-2 text-sm text-text animate-in fade-in slide-in-from-top-2`}
    >
      <span className={`${textColor} flex-1`}>{toast.message}</span>
      <button
        onClick={onDismiss}
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
