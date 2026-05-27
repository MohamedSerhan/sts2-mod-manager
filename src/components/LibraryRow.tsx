/**
 * LibraryRow — single per-mod row inside <LibraryTable>.
 *
 * Extracted from LibraryTable.tsx (post-1.7.0 cleanup) so the table
 * file stays focused on data plumbing (fetch, filter, sort, paginate,
 * mutate) and the row stays focused on rendering one mod against one
 * modpack column. The component is intentionally a pure-presentation
 * + callback shell — no Tauri calls, no toasts, no state owned here.
 * The parent owns drag indices and mutation in-flight flags; this
 * component just receives them and renders accordingly.
 */
import { Download, GripVertical, Play, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { Card } from './Card';
import type {
  ProfileMembershipMod,
  ProfileMembershipState,
} from '../types';

export function membershipRowKey(row: ProfileMembershipMod): string {
  return row.folder_name ?? row.mod_id ?? row.name;
}

export function membershipDisplayName(row: ProfileMembershipMod): string {
  return row.display_name?.trim() || row.name;
}

export function libraryStorageKey(row: ProfileMembershipMod): string {
  return `storage::${membershipRowKey(row)}`;
}

export interface LibraryRowProps {
  /** The membership grid row for this mod. */
  row: ProfileMembershipMod;
  /** Name of the focused modpack — used for ARIA labels + checkbox copy. */
  modpackName: string;
  /** Focused-profile state row pulled out of `row.profiles` by the
   *  parent (kept hoisted so the table can compute counts in one pass). */
  state: ProfileMembershipState | undefined;
  /** Whether the row belongs to the focused modpack. Derived from
   *  `state?.included`, passed for symmetry with `inPackIndex`. */
  inPack: boolean;
  /** Index inside the load-order draft (-1 when not in the pack).
   *  Drives the drag handles + rank chip. */
  inPackIndex: number;
  /** Drag highlight target. */
  isDragOver: boolean;
  /** True while a setProfileLoadOrder commit is in flight. Disables
   *  draggable + early-returns drag handlers. */
  loadOrderSaving: boolean;
  /** Per-row membership-mutation in-flight flag. */
  membershipSaving: string | null;
  /** Per-row storage-mutation in-flight flag (or BULK_STORAGE_KEY). */
  storageSaving: string | null;
  // Drag callbacks — the parent owns drag indices.
  onDragStart: (event: React.DragEvent, inPackIndex: number) => void;
  onDragOver: (event: React.DragEvent, inPackIndex: number) => void;
  onDragLeave: (inPackIndex: number) => void;
  onDrop: (event: React.DragEvent, inPackIndex: number) => void;
  onDragEnd: () => void;
  // Mutation callbacks — the parent owns Tauri calls + toasts + state.
  onToggleMembership: (row: ProfileMembershipMod) => void | Promise<void>;
  onToggleStorage: (row: ProfileMembershipMod) => void | Promise<void>;
}

export function LibraryRow({
  row,
  modpackName,
  state,
  inPack,
  inPackIndex,
  isDragOver,
  loadOrderSaving,
  membershipSaving,
  storageSaving,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggleMembership,
  onToggleStorage,
}: LibraryRowProps) {
  const { t } = useTranslation();
  const membershipKey = `${membershipRowKey(row)}::${modpackName}`;
  const saving = membershipSaving === membershipKey;
  return (
    <Card
      className={`gf-profile-library-row ${inPack ? 'in-pack' : ''} ${isDragOver ? 'drag-over' : ''}`}
      draggable={inPack && !loadOrderSaving && inPackIndex >= 0}
      onDragStart={(event) => onDragStart(event, inPackIndex)}
      onDragOver={(event) => onDragOver(event, inPackIndex)}
      onDragLeave={() => onDragLeave(inPackIndex)}
      onDrop={(event) => onDrop(event, inPackIndex)}
      onDragEnd={onDragEnd}
    >
      <div className="gf-profile-library-main">
        {inPack && (
          <div
            className="gf-load-order-drag"
            title={t('profiles.loadOrder.dragHandle')}
            aria-label={t('profiles.loadOrder.dragHandle')}
          >
            <GripVertical size={14} />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="gf-profile-library-title">
            {row.display_name?.trim() || row.name}
            {row.display_name && (
              <span className="ml-1.5 text-[10px] font-normal text-text-dim">
                {row.name}
              </span>
            )}
          </h3>
          <div className="gf-profile-library-meta">
            <span>{row.version}</span>
            {row.folder_name && <span>{row.folder_name}</span>}
            <span
              className={`gf-profile-library-storage ${row.installed_enabled ? 'active' : 'stored'}`}
            >
              {row.installed_enabled
                ? t('profiles.library.storageActive')
                : t('profiles.library.storageDisabled')}
            </span>
            {inPack && inPackIndex >= 0 && (
              <span className="gf-load-order-rank-inline">
                #{inPackIndex + 1}
              </span>
            )}
          </div>
        </div>
        <div className="gf-profile-library-storage-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onToggleStorage(row)}
            disabled={storageSaving !== null || membershipSaving !== null}
            aria-label={
              row.installed_enabled
                ? t('profiles.library.storeAria', {
                    mod: membershipDisplayName(row),
                  })
                : t('profiles.library.activateAria', {
                    mod: membershipDisplayName(row),
                  })
            }
            title={
              row.installed_enabled
                ? t('profiles.library.storeAria', {
                    mod: membershipDisplayName(row),
                  })
                : t('profiles.library.activateAria', {
                    mod: membershipDisplayName(row),
                  })
            }
          >
            {storageSaving === libraryStorageKey(row) ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : row.installed_enabled ? (
              <Download size={13} />
            ) : (
              <Play size={13} />
            )}
            {row.installed_enabled
              ? t('profiles.library.storeAction')
              : t('profiles.library.activateAction')}
          </Button>
        </div>
      </div>
      <div className="gf-profile-memberships">
        {state ? (
          <label
            className={`gf-profile-membership ${state.included ? 'active' : ''}`}
            title={
              !state.editable
                ? t('profiles.library.readOnlyTitle')
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={state.included}
              disabled={
                !state.editable
                || membershipSaving !== null
                || storageSaving !== null
              }
              onChange={() => onToggleMembership(row)}
              aria-label={t('libraryTable.membershipCheckbox', {
                mod: membershipDisplayName(row),
                modpack: modpackName,
              })}
            />
            <span className="gf-profile-membership-name">
              {state.included
                ? t('libraryTable.inPack', { modpack: modpackName })
                : t('libraryTable.notInPack', { modpack: modpackName })}
            </span>
            {!state.editable && (
              <span className="gf-profile-membership-note">
                {t('profiles.library.readOnly')}
              </span>
            )}
            {saving && <RefreshCw size={12} className="animate-spin" />}
          </label>
        ) : (
          <span className="gf-profile-library-muted">
            {t('libraryTable.modpackMissing')}
          </span>
        )}
      </div>
    </Card>
  );
}
