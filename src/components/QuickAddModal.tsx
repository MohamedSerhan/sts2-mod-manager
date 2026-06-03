import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { openExternalUrl, quickAddMod } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
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
  helperKey?: string;
}

function detect(input: string): Detected {
  const v = input.trim();
  if (!v) return { kind: null, display: '' };

  // GitHub patterns (protocol-optional)
  const ghUrl = v.match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/?#]+)/);
  if (ghUrl) return { kind: 'github', display: ghUrl[1].replace(/\.git$/, ''), helperKey: 'quickAdd.helperGithub' };

  const ghShort = v.match(/^github:([^/]+\/[^/?#]+)/);
  if (ghShort) return { kind: 'github', display: ghShort[1], helperKey: 'quickAdd.helperGithub' };

  const ghBare = v.match(/^([^/\s]+\/[^/\s]+)$/);
  if (ghBare && !v.includes('.')) return { kind: 'github', display: ghBare[1], helperKey: 'quickAdd.helperGithubAssumed' };

  const nx = parseNexusModInput(v);
  if (nx) {
    const display = /^nexus:/i.test(v)
      ? `${nx.gameDomain}/${nx.modId}`
      : `nexusmods.com/${nx.gameDomain}/mods/${nx.modId}`;
    return { kind: 'nexus', display, helperKey: 'quickAdd.helperNexus' };
  }

  return { kind: null, display: v, helperKey: 'quickAdd.helperUnrecognized' };
}

export function QuickAddModal({ open, onClose }: Props) {
  const { t } = useTranslation();
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
        toast.success(t('quickAdd.installed', { name: result.mod_info.name }));
        setUrl('');
        onClose();
      } else {
        const filesUrl = nexusFilesUrl(input);
        if (filesUrl) {
          await openExternalUrl(filesUrl);
          // Sticky toast — stays up until the downloads watcher reports
          // an install (or a 10-min fail-safe timeout fires). Replaces
          // the previous 4-second info toast that vanished before the
          // user could read it, never mind act on it.
          notifyNexusOpen(result.nexus_info.name || t('quickAdd.nexusMod'));
        } else {
          toast.info(t('quickAdd.foundNexusMod', { name: result.nexus_info.name || t('quickAdd.unknown') }));
        }
        onClose();
      }
    } catch (e) {
      toast.error(t('quickAdd.quickAddFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div
        className="gf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gf-quick-add-title"
        style={{ width: 540 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div id="gf-quick-add-title" className="gf-modal-title">{t('quickAdd.title')}</div>
            <div className="gf-modal-sub">
              {t('quickAdd.subtitle')}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          <div className="gf-field">
            <label className="gf-field-label">{t('quickAdd.urlLabel')}</label>
            <input
              className="gf-set-input"
              placeholder={t('quickAdd.urlPlaceholder')}
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
                {t('quickAdd.detected')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {detected.kind && (
                  <span className={detected.kind === 'github' ? 'gf-pill gf-pill-github' : 'gf-pill gf-pill-nexus'}>
                    {detected.kind === 'github' ? t('quickAdd.gitHubPill') : t('quickAdd.nexusPill')}
                  </span>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
                    {detected.display}
                  </div>
                  {detected.helperKey && (
                    <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginTop: 3 }}>
                      {t(detected.helperKey)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>{t('common.cancel')}</button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={handleInstall}
            disabled={busy || !detected.kind}
          >
            <Download size={12} /> {busy ? t('quickAdd.adding') : t('quickAdd.addAndInstall')}
          </button>
        </div>
      </div>
    </div>
  );
}
