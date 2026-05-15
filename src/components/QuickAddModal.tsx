import { useMemo, useState } from 'react';
import { Download, X } from 'lucide-react';
import { quickAddMod } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
import { openUrl } from '@tauri-apps/plugin-opener';
import { nexusFilesUrl, parseNexusModInput } from '../lib/nexusUrl';

// v5 batch 3 — Quick-Add by URL modal. Paste a GitHub repo URL or a Nexus
// mod page; we detect the source from the input and preview before fetching.

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Detected {
  kind: 'github' | 'nexus' | null;
  display: string;
  helper?: string;
}

function detect(input: string): Detected {
  const v = input.trim();
  if (!v) return { kind: null, display: '' };

  // GitHub patterns (protocol-optional)
  const ghUrl = v.match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/?#]+)/);
  if (ghUrl) return { kind: 'github', display: ghUrl[1].replace(/\.git$/, ''), helper: 'GitHub repo · latest release will be installed' };

  const ghShort = v.match(/^github:([^/]+\/[^/?#]+)/);
  if (ghShort) return { kind: 'github', display: ghShort[1], helper: 'GitHub repo · latest release will be installed' };

  const ghBare = v.match(/^([^/\s]+\/[^/\s]+)$/);
  if (ghBare && !v.includes('.')) return { kind: 'github', display: ghBare[1], helper: 'GitHub repo (assumed) · latest release will be installed' };

  const nx = parseNexusModInput(v);
  if (nx) {
    const display = /^nexus:/i.test(v)
      ? `${nx.gameDomain}/${nx.modId}`
      : `nexusmods.com/${nx.gameDomain}/mods/${nx.modId}`;
    return { kind: 'nexus', display, helper: 'Nexus mod · we\'ll open the Files tab — click Slow Download / Manual' };
  }

  return { kind: null, display: v, helper: 'Unrecognised URL — paste a GitHub repo or Nexus mod link' };
}

export function QuickAddModal({ open, onClose }: Props) {
  const toast = useToast();
  const { refreshAll, notifyNexusOpen } = useApp();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const detected = useMemo(() => detect(url), [url]);

  if (!open) return null;

  async function handleInstall() {
    const input = url.trim();
    if (!input) return;
    setBusy(true);
    try {
      const result = await quickAddMod(input);
      if (result.type === 'github_installed') {
        await refreshAll();
        toast.success(`Installed: ${result.mod_info.name}`);
        setUrl('');
        onClose();
      } else {
        const filesUrl = nexusFilesUrl(input);
        if (filesUrl) {
          await openUrl(filesUrl);
          // Sticky toast — stays up until the downloads watcher reports
          // an install (or a 10-min fail-safe timeout fires). Replaces
          // the previous 4-second info toast that vanished before the
          // user could read it, never mind act on it.
          notifyNexusOpen(result.nexus_info.name || 'Nexus mod');
        } else {
          toast.info(`Found Nexus mod: ${result.nexus_info.name || 'Unknown'}.`);
        }
        onClose();
      }
    } catch (e) {
      toast.error(`Quick add failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">Add a mod by URL</div>
            <div className="gf-modal-sub">
              Paste a GitHub repo or a Nexus mod page. We'll fetch the latest
              release.
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          <div className="gf-field">
            <label className="gf-field-label">URL or shorthand</label>
            <input
              className="gf-set-input"
              placeholder="github.com/owner/repo · nexusmods.com/sts2/mods/1234 · owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && detected.kind && handleInstall()}
              autoFocus
              style={{ width: '100%' }}
            />
            <div className="gf-src-edit-hint" style={{ marginTop: 6 }}>
              <code>owner/repo</code>
              <code>github.com/owner/repo</code>
              <code>nexusmods.com/sts2/mods/ID</code>
            </div>
          </div>

          {url.trim() && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                border: '1px solid var(--indigo-line)',
                borderRadius: 7,
                background: 'oklch(0.20 0.025 270 / 0.5)',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--ink-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                  marginBottom: 6,
                }}
              >
                Detected
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {detected.kind && (
                  <span className={detected.kind === 'github' ? 'gf-pill gf-pill-github' : 'gf-pill gf-pill-nexus'}>
                    {detected.kind === 'github' ? 'GH' : 'NEXUS'}
                  </span>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
                    {detected.display}
                  </div>
                  {detected.helper && (
                    <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginTop: 3 }}>
                      {detected.helper}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={handleInstall}
            disabled={busy || !detected.kind}
          >
            <Download size={12} /> {busy ? 'Adding…' : 'Add & install'}
          </button>
        </div>
      </div>
    </div>
  );
}
