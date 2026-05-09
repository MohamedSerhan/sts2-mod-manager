import { Download, ExternalLink, Star, X } from 'lucide-react';
import type { GitHubRepo, NexusModInfo } from '../types';

// v5 batch 3 — Browse mod detail drawer. Compact in-app preview before
// install. Two variants: GitHub repo or Nexus mod.

interface GhProps {
  kind: 'github';
  repo: GitHubRepo;
  installing: boolean;
  onInstall: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
}

interface NxProps {
  kind: 'nexus';
  mod: NexusModInfo;
  onOpenExternal: () => void;
  onClose: () => void;
}

type Props = GhProps | NxProps;

export function BrowseDetail(props: Props) {
  return (
    <div className="gf-modal-back" onClick={props.onClose}>
      <div className="gf-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head" style={{ padding: 0, borderBottom: 0, position: 'relative' }}>
          <div
            className="gf-detail-hero"
            style={{
              height: 110,
              borderRadius: '12px 12px 0 0',
              width: '100%',
              background:
                props.kind === 'nexus' && props.mod.picture_url
                  ? `linear-gradient(135deg, oklch(0.10 0.04 280 / 0.55), oklch(0.10 0.04 280 / 0.95)), url('${props.mod.picture_url}') center/cover`
                  : 'linear-gradient(135deg, oklch(0.40 0.10 30), oklch(0.30 0.06 280))',
            }}
          />
          <button
            className="gf-btn-3 gf-btn-icon"
            onClick={props.onClose}
            title="Close"
            style={{ position: 'absolute', top: 12, right: 12, background: 'oklch(0.10 0.04 280 / 0.6)' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {props.kind === 'github' ? (
            <>
              <div className="gf-detail-head" style={{ marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>{props.repo.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
                    {props.repo.full_name}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span className="gf-pill gf-pill-github">GitHub</span>
                    <span className="gf-pill" style={{ background: 'var(--indigo-line)', color: 'var(--ink-mute)' }}>
                      <Star size={9} style={{ marginRight: 3 }} />
                      {props.repo.stargazers_count.toLocaleString()}
                    </span>
                    {props.repo.owner?.login && (
                      <span className="gf-pill" style={{ background: 'var(--indigo-line)', color: 'var(--ink-mute)' }}>
                        by {props.repo.owner.login}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="gf-detail-content">
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-mute)', margin: 0 }}>
                  {props.repo.description || 'No description provided.'}
                </p>
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    border: '1px solid var(--indigo-line)',
                    borderRadius: 7,
                    fontSize: 11.5,
                    color: 'var(--ink-mute)',
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
                    What happens on install
                  </div>
                  We fetch the latest GitHub release for{' '}
                  <code style={{ fontFamily: 'ui-monospace, monospace' }}>{props.repo.full_name}</code>, download
                  the first asset, and place it in your mods folder. Updates check this repo whenever you run an audit.
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="gf-detail-head" style={{ marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
                    {props.mod.name || `Nexus mod #${props.mod.mod_id}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 4 }}>
                    {props.mod.author && <>by {props.mod.author}</>}
                    {props.mod.version && <> · v{props.mod.version}</>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <span className="gf-pill gf-pill-nexus">Nexus</span>
                  </div>
                </div>
              </div>
              <div className="gf-detail-content">
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-mute)', margin: 0 }}>
                  {props.mod.summary || props.mod.description || 'No summary provided.'}
                </p>
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    border: '1px solid var(--indigo-line)',
                    borderRadius: 7,
                    fontSize: 11.5,
                    color: 'var(--ink-mute)',
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
                    Nexus install
                  </div>
                  Nexus doesn't allow direct downloads — clicking install opens
                  the mod's Files tab in your browser. Pick "Mod Manager
                  Download" and the file auto-installs when it lands in your
                  Downloads folder.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={props.onClose}>Close</button>
          <div style={{ flex: 1 }} />
          <button className="gf-btn-2" onClick={props.onOpenExternal}>
            <ExternalLink size={12} /> Open in browser
          </button>
          {props.kind === 'github' && (
            <button className="gf-btn" onClick={props.onInstall} disabled={props.installing}>
              <Download size={12} /> {props.installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
