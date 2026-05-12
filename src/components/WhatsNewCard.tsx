import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Sparkles, X, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Card } from './Card';
import { getEntryForVersion, getLatestReleasedEntry, type ChangelogEntry } from '../lib/changelog';

/** localStorage key for "user dismissed the what's-new card for version X".
 *  We track per-version, not a single boolean, so a fresh release shows
 *  the card again. */
const DISMISS_PREFIX = 'sts2mm-whatsnew-seen:';

/**
 * One-shot "What's new in vX.Y.Z" card that surfaces the current
 * release's CHANGELOG entry on the Home view. Dismisses per-version via
 * localStorage so it doesn't pester users who've already read the notes.
 *
 * If the running app's version isn't in CHANGELOG.md (release script
 * skipped, dev build, etc.), we fall back to the most recent released
 * entry rather than silently showing nothing — gives mod authors testing
 * a dev build at least *something* to read.
 */
export function WhatsNewCard() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const [dismissed, setDismissed] = useState(true); // start hidden until we know

  useEffect(() => {
    getVersion()
      .then((v) => {
        setAppVersion(v);
        // Prefer the matching entry; fall back to "latest released" so
        // a dev build still has notes to show.
        const matched = getEntryForVersion(v) ?? getLatestReleasedEntry();
        setEntry(matched);
        // Has the user already dismissed this entry's version?
        try {
          const seen = localStorage.getItem(DISMISS_PREFIX + (matched?.version ?? v));
          setDismissed(seen === 'true');
        } catch {
          setDismissed(false);
        }
      })
      .catch(() => {
        // Tauri API not available (dev build, weird mount order) — try
        // the latest entry anyway.
        const matched = getLatestReleasedEntry();
        setEntry(matched);
        setDismissed(false);
      });
  }, []);

  function handleDismiss() {
    if (!entry) return;
    try {
      localStorage.setItem(DISMISS_PREFIX + entry.version, 'true');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  function handleViewFull() {
    openUrl('https://github.com/MohamedSerhan/sts2-mod-manager/blob/main/CHANGELOG.md').catch(() => {});
  }

  if (dismissed || !entry) return null;

  // The body is markdown — render a minimal subset (bullet lists +
  // ### subheadings). We deliberately don't pull in a full markdown
  // renderer for one card. Anything richer than this and the user
  // should click through to the full changelog.
  const blocks = parseSimpleMarkdown(entry.body);

  return (
    <Card className="gf-whatsnew">
      <div className="gf-whatsnew-head">
        <div className="gf-whatsnew-title">
          <Sparkles size={14} />
          <span>What's new in v{entry.version}</span>
          {entry.date && <span className="gf-whatsnew-date">· {entry.date}</span>}
        </div>
        <div className="gf-whatsnew-actions">
          <button
            className="gf-whatsnew-link"
            onClick={handleViewFull}
            title="Open the full changelog on GitHub"
          >
            <ExternalLink size={11} />
            Full changelog
          </button>
          <button
            className="gf-whatsnew-close"
            onClick={handleDismiss}
            title="Dismiss — won't show again for this version"
            aria-label="Dismiss what's new"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="gf-whatsnew-body">
        {blocks.map((b, i) => (
          <BlockRender key={i} block={b} />
        ))}
        {appVersion && entry.version !== appVersion && (
          <p className="gf-whatsnew-note">
            (Showing the latest released notes — your build is v{appVersion}.)
          </p>
        )}
      </div>
    </Card>
  );
}

type Block =
  | { kind: 'subhead'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'para'; text: string };

/** A tiny markdown subset: `###` subheadings, `-` / `*` bullet lists, and
 *  paragraphs. Inline `code` spans get rendered as <code>. Anything else
 *  passes through as plain text. */
function parseSimpleMarkdown(body: string): Block[] {
  const lines = body.split(/\r?\n/);
  const out: Block[] = [];
  let bullets: string[] | null = null;
  let paraBuf: string[] = [];

  function flushPara() {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join(' ').trim();
    if (text) out.push({ kind: 'para', text });
    paraBuf = [];
  }
  function flushBullets() {
    if (bullets) {
      out.push({ kind: 'bullets', items: bullets });
      bullets = null;
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) {
      flushPara();
      flushBullets();
      out.push({ kind: 'subhead', text: line.slice(4).trim() });
      continue;
    }
    // Drop horizontal-rule separators (`---` and friends). CHANGELOG.md
    // uses them as section dividers; rendering them as "---" paragraphs
    // is just noise on the small card surface.
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      flushBullets();
      continue;
    }
    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      flushPara();
      bullets = bullets ?? [];
      bullets.push(bulletMatch[1]);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushBullets();
      continue;
    }
    flushBullets();
    paraBuf.push(line);
  }
  flushPara();
  flushBullets();
  return out;
}

function BlockRender({ block }: { block: Block }) {
  switch (block.kind) {
    case 'subhead':
      return <div className="gf-whatsnew-subhead">{block.text}</div>;
    case 'bullets':
      return (
        <ul className="gf-whatsnew-bullets">
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case 'para':
      return <p>{renderInline(block.text)}</p>;
  }
}

/** Render inline `code` spans. Everything else stays plain text. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={i}>{p.slice(1, -1)}</code>;
    }
    return p;
  });
}
