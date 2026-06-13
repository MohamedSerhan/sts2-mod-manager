/**
 * RenameModpackModal — rename a single modpack from the detail header.
 *
 * A small, focused modal (mirrors EditModpackModal's scaffold + a11y) with
 * a prefilled name input and inline validation: blank, unchanged, and
 * case-insensitive collisions against the other existing modpack names are
 * blocked before any backend call. On a valid Save it calls the
 * `rename_profile` Tauri command (which preserves share code, active state,
 * and subscriptions), toasts, then hands the (old, new) pair up to the
 * parent so it can reload + reselect + follow the active pack.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { useModalA11y } from '../hooks/useModalA11y';
import { useToast } from '../contexts/ToastContext';
import { renameProfile } from '../hooks/useTauri';
import type { Profile } from '../types';

interface Props {
  profile: Profile;
  /** All current modpack names (for inline collision validation). */
  existingNames: string[];
  onClose: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}

export function RenameModpackModal({ profile, existingNames, onClose, onRenamed }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  // Escape / focus-trap / initial focus. Gated while saving so a stray
  // Escape can't abort an in-flight rename.
  useModalA11y(modalRef, onClose, !saving);

  function validate(candidate: string): string | null {
    const trimmed = candidate.trim();
    if (!trimmed) return t('modpack.rename.empty');
    if (trimmed === profile.name) return t('modpack.rename.unchanged');
    const clash = existingNames.some(
      (n) => n.toLowerCase() === trimmed.toLowerCase() && n !== profile.name,
    );
    if (clash) return t('modpack.rename.collision');
    return null;
  }

  async function handleSave() {
    if (saving) return;
    const trimmed = name.trim();
    const v = validate(name);
    if (v) { setError(v); return; }
    setSaving(true);
    setError(null);
    try {
      await renameProfile(profile.id || profile.name, trimmed);
      toast.success(t('modpack.rename.success', { old: profile.name, new: trimmed }));
      onRenamed(profile.name, trimmed);
      onClose();
    } catch (e) {
      toast.error(t('modpack.rename.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gf-modal-back" role="dialog" aria-modal="true"
         aria-label={t('modpack.rename.title', { name: profile.name })}
         onClick={saving ? undefined : onClose}>
      <div className="gf-modal" ref={modalRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div className="gf-modal-title">{t('modpack.rename.title', { name: profile.name })}</div>
        </div>
        <div className="gf-modal-body">
          <div className="gf-field">
            <label htmlFor="gf-rename-input" className="gf-field-label">{t('modpack.rename.label')}</label>
            <input id="gf-rename-input" className="gf-set-input" type="text" value={name}
                   aria-label={t('modpack.rename.label')}
                   placeholder={t('modpack.rename.placeholder')} disabled={saving}
                   onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                   onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }} />
          </div>
          {error && <div className="gf-create-wizard-error" role="alert">{error}</div>}
        </div>
        <div className="gf-modal-foot">
          <button type="button" className="gf-btn-3" onClick={onClose} disabled={saving}>{t('modpack.rename.cancel')}</button>
          <div style={{ flex: 1 }} />
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('modpack.rename.saving') : t('modpack.rename.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
