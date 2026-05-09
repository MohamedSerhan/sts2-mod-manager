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
  if (!open || !update) return null;

  const total = update.added_mods.length + update.updated_mods.length + update.removed_mods.length;

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">
              {total} update{total === 1 ? '' : 's'} available — {update.profile_name}
            </div>
            <div className="gf-modal-sub">
              Curated pack updates. Review what changes before syncing.
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {total === 0 ? (
            <div style={{ color: 'var(--ink-mute)', fontSize: 13 }}>
              No changes — you're already up to date.
            </div>
          ) : (
            <div className="gf-changelist">
              {update.added_mods.map((name) => (
                <div className="gf-changelist-row gf-cl-add" key={`add-${name}`}>
                  <span className="gf-cl-tag">+ ADDED</span>
                  <span className="gf-cl-name">{name}</span>
                  <span className="gf-cl-meta">new</span>
                </div>
              ))}
              {update.updated_mods.map((m) => (
                <div className="gf-changelist-row gf-cl-upd" key={`upd-${m.name}`}>
                  <span className="gf-cl-tag">↑ UPDATED</span>
                  <span className="gf-cl-name">{m.name}</span>
                  <span className="gf-cl-meta">
                    {m.old_version} → {m.new_version}
                  </span>
                </div>
              ))}
              {update.removed_mods.map((name) => (
                <div className="gf-changelist-row gf-cl-rem" key={`rem-${name}`}>
                  <span className="gf-cl-tag">− REMOVED</span>
                  <span className="gf-cl-name">{name}</span>
                  <span className="gf-cl-meta">no longer in pack</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>Skip this update</button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={() => onApply(update.share_id)}
            disabled={applying || total === 0}
          >
            <Download size={12} /> {applying ? 'Applying…' : 'Apply all'}
          </button>
        </div>
      </div>
    </div>
  );
}
