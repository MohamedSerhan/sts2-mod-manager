// v5 batch 4 — full-screen launching overlay shown while we kick off the
// game. Uses the gf-launch-* classes from styles.css.

interface Props {
  vanilla?: boolean;
  onCancel: () => void;
}

export function LaunchSpinner({ vanilla = false, onCancel }: Props) {
  return (
    <div className="gf-launch-back">
      <div className="gf-launch-card">
        <div className="gf-launch-spinner" />
        <div className="gf-launch-t">
          {vanilla ? 'Launching Slay the Spire 2 (vanilla)' : 'Launching Slay the Spire 2'}
        </div>
        <div className="gf-launch-s">
          {vanilla
            ? 'All mods are temporarily disabled · auto-backup created · waiting for Steam and the game window (Steam may take a moment if it wasn’t already running)…'
            : 'Verifying mods · auto-backup created · waiting for Steam and the game window (Steam may take a moment if it wasn’t already running)…'}
        </div>
        <button className="gf-btn-3" style={{ marginTop: 4 }} onClick={onCancel}>
          Hide
        </button>
      </div>
    </div>
  );
}
