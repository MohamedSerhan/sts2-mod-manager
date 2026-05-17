import { useEffect, useMemo, useState } from 'react';
import { Copy, Folder, Upload, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readLogTail, openLogFile } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';

// v5 batch 4 — in-app logs viewer (Settings → Advanced).
// Tails the last 500 lines of sts2mm.log, parses common levels, and
// supports filter chips + a free-text search.

type Level = 'info' | 'warn' | 'err' | 'dbg';

interface ParsedLine {
  ts: string;
  level: Level;
  text: string;
  raw: string;
}

interface FilterCounts {
  all: number;
  info: number;
  warn: number;
  err: number;
  dbg: number;
}

function classify(line: string): Level {
  // env_logger / log default formatting puts the level token in upper-case.
  if (/\bERROR\b/.test(line)) return 'err';
  if (/\bWARN(ING)?\b/.test(line)) return 'warn';
  if (/\bDEBUG\b/.test(line)) return 'dbg';
  return 'info';
}

function parse(raw: string): ParsedLine {
  // Best-effort timestamp extraction: leading ISO-like token or HH:MM:SS.
  const tsMatch = raw.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?/) ||
                  raw.match(/^\[?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?/);
  const ts = tsMatch ? tsMatch[1] : '';
  const level = classify(raw);
  const text = ts ? raw.slice(tsMatch![0].length).replace(/^\s*[\[\-:]?\s*/, '') : raw;
  return { ts, level, text, raw };
}

interface Props {
  onClose?: () => void;
}

export function LogsViewer({ onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [raw, setRaw] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | Level>('all');
  const [query, setQuery] = useState('');

  async function reload() {
    setLoading(true);
    try {
      const text = await readLogTail(500);
      setRaw(text);
    } catch (e) {
      toast.error(t('logsViewer.failedToRead', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  const lines = useMemo(() => raw.split('\n').filter(Boolean).map(parse), [raw]);

  const counts: FilterCounts = useMemo(() => {
    const c: FilterCounts = { all: lines.length, info: 0, warn: 0, err: 0, dbg: 0 };
    for (const l of lines) c[l.level]++;
    return c;
  }, [lines]);

  const filtered = useMemo(() => {
    return lines.filter((l) => {
      if (filter !== 'all' && l.level !== filter) return false;
      if (query && !l.raw.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [lines, filter, query]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(t('logsViewer.copiedToClipboard'));
    } catch (e) {
      toast.error(t('logsViewer.couldntCopy', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function openFolder() {
    try {
      await openLogFile();
    } catch (e) {
      toast.error(t('logsViewer.couldntOpen', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  function sendToSupport() {
    // Open a mailto with the recent log lines pre-filled. Real diag-bundle
    // export lives in About; this is the quick-and-dirty path.
    const body = encodeURIComponent(
      [
        t('logsViewer.supportDescribe'),
        '',
        t('logsViewer.supportRecentLog'),
        ...lines.slice(-80).map((l) => l.raw),
      ].join('\n'),
    );
    const url = `https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?title=Bug%20report&body=${body}`;
    window.open(url, '_blank');
  }

  const Chip = ({ id, label }: { id: 'all' | Level; label: string }) => (
    <button
      className={`gf-chip-filter ${filter === id ? 'on' : ''}`}
      onClick={() => setFilter(id)}
      type="button"
    >
      {label} {id !== 'all' && counts[id] > 0 ? <span style={{ opacity: 0.8 }}>{counts[id]}</span> : null}
      {id === 'all' && <span style={{ opacity: 0.8 }}>{counts.all}</span>}
    </button>
  );

  return (
    <div className="gf-logs" style={{ height: 540 }}>
      <div className="gf-logs-bar">
        <Chip id="all" label={t('logsViewer.filterAll')} />
        <Chip id="info" label={t('logsViewer.filterInfo')} />
        <Chip id="warn" label={t('logsViewer.filterWarn')} />
        <Chip id="err" label={t('logsViewer.filterError')} />
        <Chip id="dbg" label={t('logsViewer.filterDebug')} />
        <div style={{ width: 1, height: 18, background: 'var(--indigo-line)', margin: '0 4px' }} />
        <input
          className="gf-set-input"
          placeholder={t('logsViewer.filterPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, height: 26, padding: '4px 8px', fontSize: 11.5 }}
        />
        <button className="gf-btn-3 gf-btn-2-sm" onClick={reload} disabled={loading} title={t('logsViewer.reload')}>
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        <button className="gf-btn-3 gf-btn-2-sm" onClick={copyAll} title={t('logsViewer.copyLog')}>
          <Copy size={11} /> {t('common.copy')}
        </button>
        <button className="gf-btn-3 gf-btn-2-sm" onClick={openFolder} title={t('logsViewer.openFolder')}>
          <Folder size={11} /> {t('logsViewer.openBtn')}
        </button>
        <button className="gf-btn-2 gf-btn-2-sm" onClick={sendToSupport}>
          <Upload size={11} /> {t('logsViewer.sendToSupport')}
        </button>
        {onClose && (
          <button className="gf-btn-3 gf-btn-2-sm" onClick={onClose}>{t('common.close')}</button>
        )}
      </div>
      <div className="gf-logs-body">
        {loading ? (
          <div style={{ color: 'var(--ink-mute)' }}>{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: 'var(--ink-mute)' }}>
            {lines.length === 0 ? t('logsViewer.emptyLog') : t('logsViewer.noMatch')}
          </div>
        ) : (
          filtered.map((l, i) => (
            <div className={`gf-log-line ${l.level}`} key={i}>
              <span className="ts">{l.ts}</span>
              <span className="lvl">{l.level.toUpperCase()}</span>
              <span className="msg">{l.text || l.raw}</span>
            </div>
          ))
        )}
        <div style={{ marginTop: 8, padding: '6px 0', color: 'var(--ink-mute)', fontSize: 11, borderTop: '1px dashed var(--indigo-line)' }}>
          {t('logsViewer.summary', { total: lines.length, shown: filtered.length })}
        </div>
      </div>
    </div>
  );
}
