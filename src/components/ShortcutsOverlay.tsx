import { X } from 'lucide-react';

// v5 batch 4 — keyboard shortcuts overlay (press ? to open).
// The actual key handling lives in App.tsx; this is the visible reference.

interface Props {
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const SECTIONS: { title: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    title: 'Navigation',
    rows: [
      { label: 'Home', keys: ['1'] },
      { label: 'Profiles', keys: ['2'] },
      { label: 'Mods', keys: ['3'] },
      { label: 'Browse', keys: ['4'] },
      { label: 'Settings', keys: [MOD, ','] },
      { label: 'Show this overlay', keys: ['?'] },
    ],
  },
  {
    title: 'Actions',
    rows: [
      { label: 'Launch game', keys: [MOD, 'L'] },
      { label: 'Search current view', keys: ['/'] },
      { label: 'Close dialog', keys: ['Esc'] },
    ],
  },
];

export function ShortcutsOverlay({ onClose }: Props) {
  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">Keyboard shortcuts</div>
            <div className="gf-modal-sub">Press <span className="gf-kbd">?</span> anytime to open this.</div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="gf-modal-body">
          <div className="gf-kbd-grid">
            {SECTIONS.map((section) => (
              <div key={section.title} style={{ display: 'contents' }}>
                <div className="gf-kbd-section-title">{section.title}</div>
                {section.rows.map((row) => (
                  <div className="gf-kbd-row" key={row.label}>
                    <span className="label">{row.label}</span>
                    <span className="gf-kbd-keys">
                      {row.keys.map((k, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {i > 0 && <span style={{ color: 'var(--ink-mute)' }}>+</span>}
                          <span className="gf-kbd">{k}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="gf-modal-foot">
          <div style={{ flex: 1 }} />
          <button className="gf-btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
