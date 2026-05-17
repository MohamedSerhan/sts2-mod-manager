import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import type { SubscriptionUpdate } from '../types';

// v5 batch 3 — Subscription update detail modal. Shows what changed in a
// followed pack (added / updated / removed). Triggered from Home or the
// Profiles drift banner when the user wants to preview before syncing.

interface Props {
  open: boolean;
  update: SubscriptionUpdate | null;
  onClose: () => void;
  onApply: (shareId: string) => void;
  applying: boolean;
}

export function SubUpdateDetail({ open, update, onClose, onApply, applying }: Props) {
  const { t } = useTranslation();

  if (!open || !update) return null;

  const total = update.added_mods.length + update.updated_mods.length + update.removed_mods.length;

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">
              {t('subUpdate.title', { count: total, name: update.profile_name })}
            </div>
            <div className="gf-modal-sub">
              {t('subUpdate.subtitle')}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {total === 0 ? (
            <div style={{ color: 'var(--ink-mute)', fontSize: 13 }}>
              {t('subUpdate.noChanges')}
            </div>
          ) : (
            <div className="gf-changelist">
              {update.added_mods.map((name) => (
                <div className="gf-changelist-row gf-cl-add" key={`add-${name}`}>
                  <span className="gf-cl-tag">{t('subUpdate.added')}</span>
                  <span className="gf-cl-name">{name}</span>
                  <span className="gf-cl-meta">{t('subUpdate.new')}</span>
                </div>
              ))}
              {update.updated_mods.map((m) => (
                <div className="gf-changelist-row gf-cl-upd" key={`upd-${m.name}`}>
                  <span className="gf-cl-tag">{t('subUpdate.updated')}</span>
                  <span className="gf-cl-name">{m.name}</span>
                  <span className="gf-cl-meta">
                    {m.old_version} → {m.new_version}
                  </span>
                </div>
              ))}
              {update.removed_mods.map((name) => (
                <div className="gf-changelist-row gf-cl-rem" key={`rem-${name}`}>
                  <span className="gf-cl-tag">{t('subUpdate.removed')}</span>
                  <span className="gf-cl-name">{name}</span>
                  <span className="gf-cl-meta">{t('subUpdate.noLongerInPack')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>{t('subUpdate.skipThisUpdate')}</button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={() => onApply(update.share_id)}
            disabled={applying || total === 0}
          >
            <Download size={12} /> {applying ? t('subUpdate.applying') : t('subUpdate.applyAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
