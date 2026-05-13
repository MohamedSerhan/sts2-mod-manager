import { useEffect, useState } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { BrowserCard, Profile } from '../types';
import { fetchSharedProfile, installSharedProfile } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';

interface Props {
  card: BrowserCard;
  onClose: () => void;
  onInstalled?: () => void;
}

/**
 * Detail panel for a single browser card. Opens when the curator clicks
 * a row in BrowseModpacksView; fetches the full profile manifest so the
 * user can see the mod list before committing to an install.
 *
 * Wire format note: `fetchSharedProfile` / `installSharedProfile` both
 * take a single string in the `"owner/code"` shape — the Rust side
 * splits on `/` to resolve the GitHub repo + manifest path.
 */
export function BrowseModpackDetail({ card, onClose, onInstalled }: Props) {
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSharedProfile(`${card.owner}/${card.code}`)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(`Couldn't load modpack: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [card.owner, card.code, toast]);

  async function handleInstall() {
    setInstalling(true);
    try {
      await installSharedProfile(`${card.owner}/${card.code}`);
      toast.success(`Installed: ${card.name}`);
      onInstalled?.();
      onClose();
    } catch (e) {
      toast.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  async function openCuratorProfile() {
    try {
      await openUrl(`https://github.com/${card.owner}`);
    } catch {
      /* noop — opener failures aren't worth a toast here */
    }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div
        className="gf-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{card.name}</div>
            <div className="gf-modal-sub">
              <button
                className="gf-btn-3"
                onClick={openCuratorProfile}
                title="Open curator on GitHub"
                style={{ padding: '2px 6px', fontSize: 12.5 }}
              >
                @{card.owner} <ExternalLink size={11} />
              </button>
              {' · '}
              {card.mod_count} mod{card.mod_count === 1 ? '' : 's'}
            </div>
          </div>
          <button
            className="gf-btn-3 gf-btn-icon"
            onClick={onClose}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {loading && <div style={{ color: 'var(--ink-mute)' }}>Loading…</div>}
          {profile && (
            <div className="gf-mod-list">
              {profile.mods.map((m) => (
                <div key={m.name} className="gf-mod-row">
                  <span>{m.name}</span>
                  <span className="gf-dim">{m.version}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={handleInstall}
            disabled={installing || !profile}
          >
            <Download size={12} /> {installing ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
