import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { X, Check, Info, AlertCircle } from 'lucide-react';

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

// v5 — bottom-right toast stack with gf-toast pills.
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
      <div className="gf-toasts">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
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

  const variantClass = {
    success: 'gf-toast gf-toast-success',
    error: 'gf-toast gf-toast-error',
    info: 'gf-toast gf-toast-info',
  }[toast.type];

  const Icon = { success: Check, error: AlertCircle, info: Info }[toast.type];
  const iconColor = {
    success: 'var(--ok)',
    error: 'oklch(0.75 0.13 25)',
    info: 'oklch(0.75 0.10 250)',
  }[toast.type];

  const shown = visible && !leaving;

  return (
    <div
      className={variantClass}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(8px)',
        transition: `opacity ${FADE_MS}ms ease-out, transform ${FADE_MS}ms ease-out`,
      }}
    >
      <span className="gf-toast-ico" style={{ color: iconColor }}>
        <Icon size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>{toast.message}</div>
      </div>
      <button
        onClick={() => setLeaving(true)}
        className="gf-btn-3 gf-btn-icon"
        style={{ border: 0, padding: 4, minWidth: 22, height: 22 }}
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
