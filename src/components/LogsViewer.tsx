import { useEffect, useMemo, useState } from 'react';
import { Copy, Folder, Upload, RefreshCw } from 'lucide-react';
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
      toast.error(`Failed to read logs: ${e instanceof Error ? e.message : String(e)}`);
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
      toast.success('Log copied to clipboard');
    } catch (e) {
      toast.error(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function openFolder() {
    try {
      await openLogFile();
    } catch (e) {
      toast.error(`Couldn't open log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function sendToSupport() {
    // Open a mailto with the recent log lines pre-filled. Real diag-bundle
    // export lives in About; this is the quick-and-dirty path.
    const body = encodeURIComponent(
      [
        'Describe what happened:',
        '',
        '— Recent log tail —',
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
        <Chip id="all" label="All" />
        <Chip id="info" label="Info" />
        <Chip id="warn" label="Warn" />
        <Chip id="err" label="Error" />
        <Chip id="dbg" label="Debug" />
        <div style={{ width: 1, height: 18, background: 'var(--indigo-line)', margin: '0 4px' }} />
        <input
          className="gf-set-input"
          placeholder="Filter messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, height: 26, padding: '4px 8px', fontSize: 11.5 }}
        />
        <button className="gf-btn-3 gf-btn-2-sm" onClick={reload} disabled={loading} title="Reload">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        <button className="gf-btn-3 gf-btn-2-sm" onClick={copyAll} title="Copy whole log">
          <Copy size={11} /> Copy
        </button>
        <button className="gf-btn-3 gf-btn-2-sm" onClick={openFolder} title="Open log file/folder">
          <Folder size={11} /> Open
        </button>
        <button className="gf-btn-2 gf-btn-2-sm" onClick={sendToSupport}>
          <Upload size={11} /> Send to support
        </button>
        {onClose && (
          <button className="gf-btn-3 gf-btn-2-sm" onClick={onClose}>Close</button>
        )}
      </div>
      <div className="gf-logs-body">
        {loading ? (
          <div style={{ color: 'var(--ink-mute)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: 'var(--ink-mute)' }}>
            {lines.length === 0 ? 'Log is empty — actions in the app will appear here.' : 'No lines match this filter.'}
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
          {lines.length} lines (last 500) · {filtered.length} shown
        </div>
      </div>
    </div>
  );
}
