import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check, Info, AlertCircle } from 'lucide-react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
  /** Sticky toasts skip the auto-dismiss timer — caller is responsible for
   *  calling `dismiss(id)` when the underlying condition resolves (e.g. the
   *  "click Slow Download on Nexus" toast stays up until the downloads
   *  watcher reports the install). */
  sticky?: boolean;
}

interface ToastContextType {
  toast: (message: string, type?: 'success' | 'error' | 'info') => number;
  success: (message: string) => number;
  error: (message: string) => number;
  info: (message: string) => number;
  /** Show a toast that does NOT auto-dismiss. Caller dismisses it via
   *  `dismiss(id)`. Use sparingly — sticky toasts that nobody dismisses
   *  pile up forever. Always pair with a clear resolution path. */
  sticky: (message: string, type?: 'success' | 'error' | 'info') => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

const FADE_MS = 250;

let nextId = 0;

// v5 — bottom-right toast stack with gf-toast pills.
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((
    message: string,
    type: 'success' | 'error' | 'info' = 'info',
    sticky = false,
  ): number => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type, sticky }]);
    return id;
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const ctx: ToastContextType = {
    toast: (msg, type = 'info') => addToast(msg, type, false),
    success: (msg) => addToast(msg, 'success', false),
    error: (msg) => addToast(msg, 'error', false),
    info: (msg) => addToast(msg, 'info', false),
    sticky: (msg, type = 'info') => addToast(msg, type, true),
    dismiss: removeToast,
  };

  // Split errors from success/info so screen readers can announce errors
  // assertively (interrupts) while routine confirmations stay polite (queued
  // after current speech). Without these live regions, screen readers don't
  // notice toasts at all — they were the biggest a11y gap surfaced by the
  // pre-release audit.
  const errors = toasts.filter((t) => t.type === 'error');
  const polite = toasts.filter((t) => t.type !== 'error');

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="gf-toasts" aria-label={t('common.notifications')}>
        <div role="alert" aria-live="assertive" aria-atomic="false">
          {errors.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
          ))}
        </div>
        <div role="status" aria-live="polite" aria-atomic="false">
          {polite.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    if (toast.sticky) {
      // Sticky toasts skip the dismiss timer — caller controls lifetime.
      return () => cancelAnimationFrame(raf);
    }
    const dismissAt = toast.type === 'error' ? 6000 : 4000;
    const dismissTimer = setTimeout(() => setLeaving(true), dismissAt);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(dismissTimer);
    };
  }, [toast.type, toast.sticky]);

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
      <span className="gf-toast-ico" style={{ color: iconColor }} aria-hidden="true">
        <Icon size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>{toast.message}</div>
      </div>
      <button
        onClick={() => setLeaving(true)}
        className="gf-btn-3 gf-btn-icon"
        style={{ border: 0, padding: 4, minWidth: 22, height: 22 }}
        title={t('common.dismiss')}
        aria-label={t('common.dismiss')}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
