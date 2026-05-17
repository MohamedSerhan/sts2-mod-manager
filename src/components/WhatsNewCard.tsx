import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { Sparkles, X, ExternalLink, Info } from 'lucide-react';
import { Card } from './Card';
import { getEntryForVersion, getLatestReleasedEntry, type ChangelogEntry } from '../lib/changelog';
import { openExternalUrl } from '../hooks/useTauri';

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
  const { t, i18n } = useTranslation();
  // Show a maintainer-can't-translate notice on top of the card whenever
  // the active locale isn't English. Dismissed alongside the card itself
  // (per-version) so users see it on every new release until they ack.
  const showLocaleNotice = i18n.language && !i18n.language.startsWith('en');
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
    openExternalUrl('https://github.com/MohamedSerhan/sts2-mod-manager/blob/main/CHANGELOG.md').catch(() => {});
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
          <span>{t('whatsNew.title', { version: entry.version })}</span>
          {entry.date && <span className="gf-whatsnew-date">· {entry.date}</span>}
        </div>
        <div className="gf-whatsnew-actions">
          <button
            className="gf-whatsnew-link"
            onClick={handleViewFull}
            title={t('whatsNew.fullChangelogTitle')}
          >
            <ExternalLink size={11} />
            {t('whatsNew.fullChangelog')}
          </button>
          <button
            className="gf-whatsnew-close"
            onClick={handleDismiss}
            title={t('whatsNew.dismissTitle')}
            aria-label={t('whatsNew.dismissAria')}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="gf-whatsnew-body">
        {showLocaleNotice && (
          <div className="gf-whatsnew-locale-note">
            <Info size={12} />
            <span>
              {t('whatsNew.localeNotice')}{' '}
              <button
                type="button"
                className="gf-whatsnew-locale-link"
                onClick={() =>
                  openExternalUrl(
                    'https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?labels=translation',
                  ).catch(() => {})
                }
              >
                {t('whatsNew.localeNoticeReport')}
              </button>
            </span>
          </div>
        )}
        {blocks.map((b, i) => (
          <BlockRender key={i} block={b} />
        ))}
        {appVersion && entry.version !== appVersion && (
          <p className="gf-whatsnew-note">
            {t('whatsNew.devNote', { version: appVersion })}
          </p>
        )}
      </div>
    </Card>
  );
}

export type Block =
  | { kind: 'subhead'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'para'; text: string };

/** A tiny markdown subset: `###` subheadings, `-` / `*` bullet lists, and
 *  paragraphs. Empty sections are dropped so release notes do not show
 *  headings with no user-facing content. Inline formatting is handled by
 *  the renderer. Exported for unit tests; the runtime caller is
 *  `WhatsNewCard` below. */
export function parseSimpleMarkdown(body: string): Block[] {
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
  return dropEmptySections(out);
}

function blockHasVisibleContent(block: Block): boolean {
  switch (block.kind) {
    case 'bullets':
      return block.items.some((item) => item.trim().length > 0);
    case 'para':
      return block.text.trim().length > 0;
    case 'subhead':
      return false;
  }
}

function dropEmptySections(blocks: Block[]): Block[] {
  return blocks.filter((block, index) => {
    if (block.kind !== 'subhead') return true;

    for (let i = index + 1; i < blocks.length; i += 1) {
      const next = blocks[i];
      if (next.kind === 'subhead') return false;
      if (blockHasVisibleContent(next)) return true;
    }

    return false;
  });
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

/** Render inline `code` and **strong** spans. Everything else stays plain text. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.flatMap((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`code-${i}`}>{p.slice(1, -1)}</code>;
    }
    return renderStrong(p, `text-${i}`);
  });
}

function renderStrong(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+?\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <strong key={`${keyPrefix}-strong-${i}`} className="gf-whatsnew-strong">
          {p.slice(2, -2)}
        </strong>
      );
    }
    return p;
  });
}
