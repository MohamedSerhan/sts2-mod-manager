import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();

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
                  ? `linear-gradient(135deg, color-mix(in oklch, var(--indigo-deep) 55%, transparent), color-mix(in oklch, var(--indigo-deep) 95%, transparent)), url('${props.mod.picture_url}') center/cover`
                  : 'linear-gradient(135deg, var(--hero-fill-warm), var(--indigo-shimmer))',
            }}
          />
          <button
            className="gf-btn-3 gf-btn-icon"
            onClick={props.onClose}
            title={t('common.close')}
            style={{ position: 'absolute', top: 12, insetInlineEnd: 12, background: 'color-mix(in oklch, var(--indigo-deep) 60%, transparent)' }}
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
                    <span className="gf-pill gf-pill-github">{t('browseDetail.github')}</span>
                    <span className="gf-pill" style={{ background: 'var(--indigo-line)', color: 'var(--ink-mute)' }}>
                      <Star size={9} style={{ marginInlineEnd: 3 }} />
                      {props.repo.stargazers_count.toLocaleString()}
                    </span>
                    {props.repo.owner?.login && (
                      <span className="gf-pill" style={{ background: 'var(--indigo-line)', color: 'var(--ink-mute)' }}>
                        {t('browseDetail.by', { name: props.repo.owner.login })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="gf-detail-content">
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-mute)', margin: 0 }}>
                  {props.repo.description || t('browseDetail.noDescription')}
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
                    {t('browseDetail.whatHappensTitle')}
                  </div>
                  {t('browseDetail.whatHappensBody', { repo: props.repo.full_name })}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="gf-detail-head" style={{ marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
                    {props.mod.name || t('browseDetail.nexusModNum', { id: props.mod.mod_id })}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 4 }}>
                    {props.mod.author && <>{t('browseDetail.by', { name: props.mod.author })}</>}
                    {props.mod.version && <> · v{props.mod.version}</>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <span className="gf-pill gf-pill-nexus">{t('browseDetail.nexus')}</span>
                  </div>
                </div>
              </div>
              <div className="gf-detail-content">
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-mute)', margin: 0 }}>
                  {props.mod.summary || props.mod.description || t('browseDetail.noSummary')}
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
                    {t('browseDetail.nexusInstallTitle')}
                  </div>
                  {t('browseDetail.nexusInstallBody')}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={props.onClose}>{t('common.close')}</button>
          <div style={{ flex: 1 }} />
          <button className="gf-btn-2" onClick={props.onOpenExternal}>
            <ExternalLink size={12} /> {t('browseDetail.openInBrowser')}
          </button>
          {props.kind === 'github' && (
            <button className="gf-btn" onClick={props.onInstall} disabled={props.installing}>
              <Download size={12} /> {props.installing ? t('browseDetail.installing') : t('browseDetail.install')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
