import { createContext, useCallback, useContext, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';

import { useModalA11y } from '../hooks/useModalA11y';

// v5 batch 4 — promise-based confirm dialog. Replaces window.confirm() with
// a styled gf-modal. Supports an optional checkbox (returns its value too)
// and an optional typed-phrase confirmation for high-stakes actions.
//
//   const confirm = useConfirm();
//   const result = await confirm({
//     title: 'Delete all mods?',
//     body: '…',
//     destructive: true,
//     confirmLabel: 'Delete everything',
//     typedPhrase: 'delete all',
//     checkbox: { label: 'Also wipe the mods folder on disk' },
//   });
//   // result is `false` (cancelled) or `{ confirmed: true, checked: boolean }`.

interface CheckboxOption {
  label: string;
  defaultChecked?: boolean;
}

export interface ConfirmOptions {
  title: string;
  /** Body copy under the title. Pass a string for simple cases or a
   *  ReactNode when you need a list (e.g. share-code import shows the
   *  source URLs as bullets). */
  body?: ReactNode;
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** When set, the user must type the phrase exactly to enable Confirm. */
  typedPhrase?: string;
  /** Optional checkbox; result.checked reflects the final state. */
  checkbox?: CheckboxOption;
  /** Optional override for the modal's pixel width. Default 480. The
   *  share-import preview wants more room for the source list. */
  width?: number;
  /** When provided, replaces the single confirm button with one button
   *  per choice. Clicking one resolves with `{ confirmed: true, choice }`.
   *  Dismissing (X / backdrop / the cancel button) still resolves `false`. */
  choices?: Array<{ value: string; label: string; variant?: 'primary' | 'secondary' | 'danger' }>;
}

export type ConfirmResult = false | { confirmed: true; checked: boolean; choice?: string };

type ConfirmFn = (opts: ConfirmOptions) => Promise<ConfirmResult>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: ConfirmResult) => void;
}

interface ConfirmModalProps {
  pending: PendingConfirm;
  typed: string;
  setTyped: (v: string) => void;
  checked: boolean;
  setChecked: (v: boolean) => void;
  checkedRef: MutableRefObject<boolean>;
  phraseOk: boolean;
  close: (confirmed: boolean) => void;
  resolveChoice: (value: string) => void;
}

function ConfirmModal({
  pending,
  typed,
  setTyped,
  checked,
  setChecked,
  checkedRef,
  phraseOk,
  close,
  resolveChoice,
}: ConfirmModalProps) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLElement>(null);
  useModalA11y(modalRef, () => close(false));

  return (
    <div className="gf-modal-back" onClick={() => close(false)}>
      <div
        ref={modalRef as RefObject<HTMLDivElement>}
        className="gf-modal"
        style={{ width: pending.width ?? 480 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gf-confirm-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="gf-modal-head"
          style={pending.destructive ? { background: 'color-mix(in oklch, var(--danger) 6%, transparent)' } : undefined}
        >
          <div>
            <div id="gf-confirm-title" className="gf-modal-title">{pending.title}</div>
            {pending.body && <div className="gf-modal-sub">{pending.body}</div>}
          </div>
          <button
            onClick={() => close(false)}
            className="gf-btn-3 gf-btn-icon"
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
          >
            <X size={14} />
          </button>
        </div>

        {(pending.warning || pending.checkbox || pending.typedPhrase) && (
          <div className="gf-modal-body">
            {pending.warning && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: 12,
                  background: 'color-mix(in oklch, var(--danger-edge) 10%, transparent)',
                  border: '1px solid color-mix(in oklch, var(--danger-edge) 30%, transparent)',
                  borderRadius: 7,
                  marginBottom: pending.checkbox || pending.typedPhrase ? 12 : 0,
                }}
              >
                <AlertTriangle size={16} style={{ color: 'var(--danger-bright)', flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: 'var(--danger-msg)' }}>{pending.warning}</div>
              </div>
            )}
            {pending.checkbox && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  color: 'var(--ink)',
                  marginBottom: pending.typedPhrase ? 12 : 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setChecked(e.target.checked);
                    checkedRef.current = e.target.checked;
                  }}
                />
                {pending.checkbox.label}
              </label>
            )}
            {pending.typedPhrase && (
              <div style={{ fontSize: 12.5, color: 'var(--danger-text)' }}>
                <Trans i18nKey="confirm.typePhrase" values={{ phrase: pending.typedPhrase }}>
                  Type <b>{pending.typedPhrase}</b> to confirm:
                </Trans>
                <input
                  className={`gf-set-input ${typed && !phraseOk ? 'is-err' : phraseOk && typed ? 'is-ok' : ''}`}
                  placeholder={pending.typedPhrase}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  style={{ marginTop: 6, display: 'block', width: '100%' }}
                  autoFocus
                />
              </div>
            )}
          </div>
        )}

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={() => close(false)}>
            {pending.cancelLabel || t('common.cancel')}
          </button>
          <div style={{ flex: 1 }} />
          {pending.choices ? (
            pending.choices.map((choice) => (
              <button
                key={choice.value}
                disabled={pending.typedPhrase ? !phraseOk : undefined}
                className={
                  choice.variant === 'danger'
                    ? 'gf-btn-3 gf-btn-danger'
                    : choice.variant === 'secondary'
                    ? 'gf-btn-2'
                    : 'gf-btn'
                }
                onClick={() => resolveChoice(choice.value)}
              >
                {choice.label}
              </button>
            ))
          ) : (
            <button
              className={pending.destructive ? 'gf-btn-3 gf-btn-danger' : 'gf-btn'}
              onClick={() => close(true)}
              disabled={!phraseOk}
              autoFocus={!pending.typedPhrase}
              style={pending.destructive && pending.typedPhrase ? { background: 'var(--danger)', color: '#fff', border: 0 } : undefined}
            >
              {pending.confirmLabel || (pending.destructive ? t('common.delete') : t('common.confirm'))}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const checkedRef = useRef(false);

  const confirm: ConfirmFn = useCallback((opts) => {
    return new Promise<ConfirmResult>((resolve) => {
      setTyped('');
      const initial = opts.checkbox?.defaultChecked ?? false;
      setChecked(initial);
      checkedRef.current = initial;
      setPending({ ...opts, resolve });
    });
  }, []);

  function close(confirmed: boolean) {
    if (!pending) return;
    pending.resolve(confirmed ? { confirmed: true, checked: checkedRef.current } : false);
    setPending(null);
  }

  function resolveChoice(value: string) {
    if (!pending) return;
    pending.resolve({ confirmed: true, checked: checkedRef.current, choice: value });
    setPending(null);
  }

  const phraseOk = !pending?.typedPhrase || typed.trim().toLowerCase() === pending.typedPhrase.toLowerCase();

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmModal
          pending={pending}
          typed={typed}
          setTyped={setTyped}
          checked={checked}
          setChecked={setChecked}
          checkedRef={checkedRef}
          phraseOk={phraseOk}
          close={close}
          resolveChoice={resolveChoice}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
