/**
 * EditModpackModal — bulk-edit a modpack's membership with the same handy
 * checkbox picker the create-modpack wizard uses (ModMultiSelect). Opens
 * pre-populated with the pack's current mods; on save it diffs the new
 * selection against the manifest and applies only the changes.
 *
 * On the *active* pack, adds also enable the mod in-game and removes also
 * unload it — same "pack = live loadout" coupling as the rest of the
 * modpack view. On an inactive pack, only membership changes.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { ModMultiSelect } from './ModMultiSelect';
import { useModalA11y } from '../hooks/useModalA11y';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { setProfileModMembership, toggleMod } from '../hooks/useTauri';
import type { Profile } from '../types';

interface Props {
  profile: Profile;
  onClose: () => void;
  /** Called after at least one membership change is saved, so the parent
   *  can refresh its profile list / drift / share metadata. */
  onSaved?: () => void;
}

export function EditModpackModal({ profile, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { mods, activeProfile } = useApp();
  const toast = useToast();
  const isActive = activeProfile === profile.name;

  // Selection starts as the pack's current members, keyed by folder so two
  // mods that share a manifest name are tracked (and diffed) independently.
  const initialSelected = useMemo(
    () => new Set(profile.mods.map((m) => m.folder_name ?? m.name)),
    [profile.mods],
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [saving, setSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  // Escape / focus-trap / initial focus. Gated while saving so a stray Escape
  // can't abort an in-flight membership write.
  useModalA11y(modalRef, onClose, !saving);

  const labels = {
    searchPlaceholder: t('createModpack.step2SearchPlaceholder'),
    sortLabel: t('createModpack.step2SortLabel'),
    sortByName: t('createModpack.step2SortByName'),
    sortBySize: t('createModpack.step2SortBySize'),
    sortByActive: t('createModpack.step2SortByEnabled'),
    selectedCount: (count: number) => t('createModpack.step2SelectedCount', { count }),
    selectAll: t('createModpack.step2SelectAll'),
    deselectAll: t('createModpack.step2DeselectAll'),
    noMods: t('createModpack.step2NoMods'),
  };

  async function handleSave() {
    if (saving) return;
    const current = new Set(profile.mods.map((m) => m.folder_name ?? m.name));
    // toAdd: now-checked mods that weren't in the pack.
    const toAdd = mods.filter(
      (m) => selected.has(m.folder_name ?? m.name) && !current.has(m.folder_name ?? m.name),
    );
    // toRemove: pack mods that are no longer checked.
    const toRemove = profile.mods.filter((m) => !selected.has(m.folder_name ?? m.name));

    if (toAdd.length === 0 && toRemove.length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      // Toggle the live mods/ folder BEFORE writing the manifest: toggle_mod
      // guards on the game running (and can fail the file move) while the
      // membership write doesn't. Doing the guarded step first keeps the two
      // in sync — a running game aborts the whole change instead of stranding
      // a manifest edit with no matching disk move.
      for (const m of toAdd) {
        if (isActive) await toggleMod(m.name, m.folder_name ?? null, true);
        await setProfileModMembership(profile.name, m.name, m.folder_name ?? null, m.mod_id ?? null, true);
      }
      for (const m of toRemove) {
        if (isActive) await toggleMod(m.name, m.folder_name ?? null, false);
        await setProfileModMembership(profile.name, m.name, m.folder_name ?? null, m.mod_id ?? null, false);
      }
      toast.success(
        t('modpack.edit.saved', { added: toAdd.length, removed: toRemove.length, name: profile.name }),
      );
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(
        t('modpack.edit.failed', { error: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="gf-modal-back"
      role="dialog"
      aria-modal="true"
      aria-label={t('modpack.edit.title', { name: profile.name })}
      onClick={saving ? undefined : onClose}
    >
      <div
        className="gf-modal gf-create-wizard"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{t('modpack.edit.title', { name: profile.name })}</div>
            <div className="gf-modal-sub">{t('modpack.edit.subtitle')}</div>
          </div>
        </div>

        <div className="gf-modal-body">
          <ModMultiSelect
            mods={mods}
            selected={selected}
            onChange={setSelected}
            labels={labels}
          />
        </div>

        <div className="gf-modal-foot">
          <button type="button" className="gf-btn-3" onClick={onClose} disabled={saving}>
            {t('modpack.edit.cancel')}
          </button>
          <div style={{ flex: 1 }} />
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('modpack.edit.saving') : t('modpack.edit.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
