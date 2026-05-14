import { useState } from 'react';
import { Check, X, GitBranch, ExternalLink, Search, Save, StickyNote, Link as LinkIcon } from 'lucide-react';
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
  onFindGithub: () => void;
  onSave: (
    githubRepo: string,
    nexusUrl: string,
    note: string,
    customUrl: string,
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
  const [github, setGithub] = useState<string>(ghRepoFromUrl(mod.github_url));
  const [nexus, setNexus] = useState<string>(mod.nexus_url ?? '');
  const [note, setNote] = useState<string>(mod.note ?? '');
  const [customUrl, setCustomUrl] = useState<string>(mod.custom_url ?? '');

  const ghOk = github.trim().length > 0;
  const nxOk = nexus.trim().length > 0;
  const onlyNexus = nxOk && !ghOk;

  function statusBadge(ok: boolean) {
    return ok ? (
      <span className="gf-src-edit-status gf-src-edit-status-ok">
        <Check size={9} style={{ display: 'inline', marginRight: 2 }} /> OK
      </span>
    ) : (
      <span className="gf-src-edit-status gf-src-edit-status-empty">empty</span>
    );
  }

  return (
    <div className="gf-src-edit">
      <div className="gf-src-edit-head">
        <div>
          <div className="gf-src-edit-title">Sources for {mod.name}</div>
          <div className="gf-src-edit-sub">
            Linking enables auto-updates from GitHub releases or Nexus.
          </div>
        </div>
        <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close editor">
          <X size={12} />
        </button>
      </div>

      <div className="gf-src-edit-grid">
        {/* GitHub */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <GitBranch size={11} style={{ marginRight: 4 }} />
            GitHub repo
            {github && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setGithub('')}
              >
                clear
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder="owner/repo"
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
            Nexus mod URL
            {nexus && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setNexus('')}
              >
                clear
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={nexus}
              onChange={(e) => setNexus(e.target.value)}
              placeholder="https://www.nexusmods.com/sts2/mods/123"
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
            Note
            {note && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setNote('')}
              >
                clear
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. downloaded from Patreon, compat patch for v1.8 build"
              rows={2}
              style={{ resize: 'vertical', minHeight: 30, fontFamily: 'inherit' }}
            />
          </div>
          <div className="gf-src-edit-hint">
            <span>Free-form. Shown on the mod row so you remember where this came from.</span>
          </div>
        </div>

        {/* Custom (non-GitHub/Nexus) URL */}
        <div className="gf-src-edit-field">
          <label className="gf-src-edit-label">
            <LinkIcon size={11} style={{ marginRight: 4 }} />
            Other link
            {customUrl && (
              <button
                type="button"
                className="gf-src-edit-clear"
                onClick={() => setCustomUrl('')}
              >
                clear
              </button>
            )}
          </label>
          <div className="gf-src-edit-input">
            <input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://… (Patreon, X, Discord, etc.)"
            />
            {statusBadge(customUrl.trim().length > 0)}
          </div>
          <div className="gf-src-edit-hint">
            <span>For mods that don't live on GitHub or Nexus.</span>
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
            Nexus-only mod — try fetching the GitHub repo from the Nexus
            description so updates are checked from both sources.
          </span>
          <button className="gf-btn-3 gf-btn-2-sm" onClick={onFindGithub} disabled={findingGithub}>
            {findingGithub ? 'Searching…' : 'Find GitHub'}
          </button>
        </div>
      )}

      <div className="gf-src-edit-foot">
        {(mod.github_url || mod.nexus_url) && (
          <button className="gf-btn-3 gf-btn-2-sm gf-btn-danger" onClick={onClear}>
            Clear all links
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="gf-btn-3" onClick={onClose}>Cancel</button>
        <button
          className="gf-btn gf-btn-sm"
          onClick={() => onSave(github, nexus, note, customUrl)}
          disabled={saving}
        >
          <Save size={11} /> {saving ? 'Saving…' : 'Save sources'}
        </button>
      </div>
    </div>
  );
}
