import { useState } from 'react';
import { Check, X, GitBranch, ExternalLink, Search, Save, StickyNote, Link as LinkIcon, Type, FileText, Tags } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModInfo } from '../types';

// v5 batch 2 — inline source editor drawer.
// Two-field grid (GitHub repo + Nexus URL) with format hints, per-field
// clear, status badge (ok/empty), and "Find GitHub from Nexus" hint when
// only Nexus is set. Renders below an expanded mod row.
//
// Plus user-feedback batch additions: a free-form Note field and a single
// "Other link" URL for mods that come from places that aren't GitHub or
// Nexus (Patreon, X, Discord posts). Both are optional and saved through
// the separate `setModExtras` command so they live on the same source
// entry but don't get clobbered by GitHub/Nexus saves.

interface Props {
  mod: ModInfo;
  saving: boolean;
  findingGithub: boolean;
  onClose: () => void;
  onClear: () => void;
  /** Runs the "find GitHub from Nexus" lookup. Resolves to the discovered
   *  repo (bare `owner/repo` or a full URL) so the editor can reflect it into
   *  the GitHub field, or `null` when nothing was found. */
  onFindGithub: () => Promise<string | null>;
  onSave: (
    githubRepo: string,
    nexusUrl: string,
    note: string,
    customUrl: string,
    displayName: string,
    displayDescription: string,
    tags: string,
  ) => void | Promise<void>;
}

function ghRepoFromUrl(url: string | null): string {
  if (!url) return '';
  // Accept either bare owner/repo or full https URL
  const m = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/?#]+)/);
  if (m) return m[1].replace(/\.git$/, '');
  return url;
}

export function SourceEditor({
  mod,
  saving,
  findingGithub,
  onClose,
  onClear,
  onFindGithub,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const [github, setGithub] = useState<string>(ghRepoFromUrl(mod.github_url));
  const [nexus, setNexus] = useState<string>(mod.nexus_url ?? '');
  const [note, setNote] = useState<string>(mod.note ?? '');
  const [customUrl, setCustomUrl] = useState<string>(mod.custom_url ?? '');
  const [displayName, setDisplayName] = useState<string>(mod.display_name ?? '');
  const [displayDescription, setDisplayDescription] = useState<string>(mod.display_description ?? '');
  const [tags, setTags] = useState<string>((mod.tags ?? []).join(', '));

  const ghOk = github.trim().length > 0;
  const nxOk = nexus.trim().length > 0;
  const onlyNexus = nxOk && !ghOk;
  const titleName = mod.display_name?.trim() || mod.name;

  // Bug 1: reflect a successful lookup straight into the field. Without
  // this the field stayed empty (seeded from props only at mount), the
  // Nexus-only banner lingered, and a follow-up Save compared the stale
  // empty field against the refreshed mod.github_url and wrote null over
  // the just-found repo.
  async function handleFind() {
    const repo = await onFindGithub();
    if (repo) setGithub(ghRepoFromUrl(repo));
  }

  function statusBadge(ok: boolean) {
    return ok ? (
      <span className="gf-src-edit-status gf-src-edit-status-ok">
        <Check size={9} style={{ display: 'inline', marginRight: 2 }} /> {t('sourceEditor.ok')}
      </span>
    ) : (
      <span className="gf-src-edit-status gf-src-edit-status-empty">{t('sourceEditor.empty')}</span>
    );
  }

  return (
    <div className="gf-src-edit">
      <div className="gf-src-edit-head">
        <div>
          <div className="gf-src-edit-title">{t('sourceEditor.title', { name: titleName })}</div>
          <div className="gf-src-edit-sub">
            {t('sourceEditor.subtitle')}
          </div>
        </div>
        <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('sourceEditor.closeEditor')}>
          <X size={12} />
        </button>
      </div>

      <div className="gf-src-edit-grid">
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <Type size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.displayName')}
            {displayName && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setDisplayName('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={mod.name}
            />
          </div>
          <div className="gf-src-edit-hint">
            <span>{t('sourceEditor.displayNameHint')}</span>
          </div>
        </div>

        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <FileText size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.displayDescription')}
            {displayDescription && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setDisplayDescription('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <textarea
              value={displayDescription}
              onChange={(e) => setDisplayDescription(e.target.value)}
              placeholder={mod.description || t('sourceEditor.displayDescriptionPlaceholder')}
              rows={2}
            />
          </div>
          <div className="gf-src-edit-hint">
            <span>{t('sourceEditor.displayDescriptionHint')}</span>
          </div>
        </div>
      </div>

      <div className="gf-src-edit-grid">
        {/* GitHub */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <GitBranch size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.githubRepo')}
            {github && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setGithub('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder={t('sourceEditor.githubPlaceholder')}
            />
            {statusBadge(ghOk)}
          </div>
          <div className="gf-src-edit-hint">
            <code>owner/repo</code>
            <code>github.com/owner/repo</code>
          </div>
        </div>

        {/* Nexus */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <ExternalLink size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.nexusUrl')}
            {nexus && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setNexus('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={nexus}
              onChange={(e) => setNexus(e.target.value)}
              placeholder={t('sourceEditor.nexusPlaceholder')}
            />
            {statusBadge(nxOk)}
          </div>
          <div className="gf-src-edit-hint">
            <code>nexusmods.com/sts2/mods/ID</code>
          </div>
        </div>
      </div>

      <div className="gf-src-edit-grid">
        {/* Free-form note */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <StickyNote size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.note')}
            {note && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setNote('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('sourceEditor.notePlaceholder')}
              rows={2}
            />
          </div>
          <div className="gf-src-edit-hint">
            <span>{t('sourceEditor.noteHint')}</span>
          </div>
        </div>

        {/* Custom (non-GitHub/Nexus) URL */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <LinkIcon size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.otherLink')}
            {customUrl && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setCustomUrl('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder={t('sourceEditor.otherLinkPlaceholder')}
            />
            {statusBadge(customUrl.trim().length > 0)}
          </div>
          <div className="gf-src-edit-hint">
            <span>{t('sourceEditor.otherLinkHint')}</span>
          </div>
        </div>
      </div>

      <div className="gf-src-edit-grid">
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <Tags size={11} style={{ marginRight: 4 }} />
            {t('sourceEditor.tags')}
            {tags && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setTags('')}
              >
                {t('sourceEditor.clear')}
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('sourceEditor.tagsPlaceholder')}
            />
          </div>
          <div className="gf-src-edit-hint">
            <span>{t('sourceEditor.tagsHint')}</span>
          </div>
        </div>
      </div>

      {onlyNexus && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 11px',
            borderRadius: 7,
            background: 'oklch(0.55 0.13 250 / 0.10)',
            border: '1px solid oklch(0.55 0.13 250 / 0.3)',
            fontSize: 11.5,
            color: 'oklch(0.85 0.07 250)',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <Search size={12} />
          <span style={{ flex: 1 }}>
            {t('sourceEditor.nexusOnlyMessage')}
          </span>
          <button className="gf-btn-3 gf-btn-2-sm" onClick={handleFind} disabled={findingGithub}>
            {findingGithub ? t('sourceEditor.searching') : t('sourceEditor.findGitHub')}
          </button>
        </div>
      )}

      <div className="gf-src-edit-foot">
        {(mod.github_url || mod.nexus_url) && (
          <button className="gf-btn-3 gf-btn-2-sm gf-btn-danger" onClick={onClear}>
            {t('sourceEditor.clearAllLinks')}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="gf-btn-3" onClick={onClose}>{t('common.cancel')}</button>
        <button
          className="gf-btn gf-btn-sm"
          onClick={() => onSave(github, nexus, note, customUrl, displayName, displayDescription, tags)}
          disabled={saving}
        >
          <Save size={11} /> {saving ? t('sourceEditor.saving') : t('sourceEditor.saveSources')}
        </button>
      </div>
    </div>
  );
}
