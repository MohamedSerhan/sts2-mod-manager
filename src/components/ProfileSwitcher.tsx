import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { listProfiles, switchProfile, checkSubscriptionUpdates, getProfileDrift } from '../hooks/useTauri';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmDialog';
import type { Profile, SubscriptionUpdate } from '../types';

// v5 — Profile switcher popover. Opens from the top-bar profile chip.
// Lists all profiles with the active one highlighted; click a row to
// switch, or use the foot buttons to add a pack / manage all.

interface Props {
  onClose: () => void;
  onAddPack: () => void;
  onManageAll: () => void;
}

function packInitials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function modCount(profile: Profile): number {
  return profile.mods.length;
}

export function ProfileSwitcher({ onClose, onAddPack, onManageAll }: Props) {
  const { activeProfile, setActiveProfile, refreshAll } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [updates, setUpdates] = useState<SubscriptionUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, updateList] = await Promise.all([
          listProfiles().catch(() => []),
          checkSubscriptionUpdates().catch(() => [] as SubscriptionUpdate[]),
        ]);
        if (cancelled) return;
        setProfiles(list);
        setUpdates(updateList.filter((u) => u.has_update));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Click outside or Esc → close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    function handleClick(e: MouseEvent) {
      // Close on outside click — but the popover's parent wrapper also contains
      // the trigger button (chip), so check the parent. That way clicking the
      // chip again to close (toggle behaviour) goes through React state, not
      // the outside-click handler.
      const wrapper = popRef.current?.parentElement;
      if (wrapper && !wrapper.contains(e.target as Node)) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    // Defer to next tick so the click that opened the popover doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      window.removeEventListener('keydown', handleKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  async function handleSwitch(name: string) {
    if (name === activeProfile) {
      onClose();
      return;
    }
    if (activeProfile) {
      try {
        const drift = await getProfileDrift(activeProfile);
        if (drift.has_drift) {
          const ok = await confirm({
            title: `Switch away from "${activeProfile}"?`,
            body: 'This profile has unsaved changes on disk. Switching applies another manifest and those working changes will not be saved to the current profile.',
            warning: 'Open Profiles and use Save changes first if you want to keep them.',
            confirmLabel: 'Switch anyway',
            cancelLabel: 'Stay here',
          });
          if (!ok) return;
        }
      } catch {
        // Drift is advisory. If it cannot be checked, keep switching usable.
      }
    }
    setSwitching(name);
    try {
      const result = await switchProfile(name);
      setActiveProfile(name);
      await refreshAll();
      if (result.missing_mods.length > 0) {
        toast.info(
          `Activated "${name}". ${result.downloaded} downloaded, ${result.missing_mods.length} still missing.`,
        );
      } else {
        toast.success(`Activated "${name}"`);
      }
      onClose();
    } catch (e) {
      toast.error(`Failed to switch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(null);
    }
  }

  function updateCountFor(profileName: string): number {
    const u = updates.find((x) => x.profile_name === profileName);
    if (!u) return 0;
    return (u.added_mods?.length || 0) + (u.updated_mods?.length || 0) + (u.removed_mods?.length || 0);
  }

  // Vanilla isn't a profile — it's the top-bar Vanilla button. Filter out
  // any profile literally named "Vanilla" so it doesn't show up here.
  const visibleProfiles: Profile[] = profiles.filter(
    (p) => p.name.toLowerCase() !== 'vanilla',
  );

  return (
    <div
      ref={popRef}
      className="gf-pop"
      style={{ top: 'calc(100% + 4px)', left: 0, right: 'auto' }}
    >
      <div className="gf-pop-head">Switch active pack</div>
      {loading ? (
        <div style={{ padding: '14px 12px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-mute)', fontSize: 12 }}>
          <RefreshCw size={12} className="animate-spin" /> Loading…
        </div>
      ) : visibleProfiles.length === 0 ? (
        <div style={{ padding: '14px 12px', color: 'var(--ink-mute)', fontSize: 12 }}>
          No profiles yet. Add a pack to get started.
        </div>
      ) : (
        visibleProfiles.map((p) => {
          const isActive = activeProfile === p.name;
          const count = modCount(p);
          const updateCount = updateCountFor(p.name);
          const initials = packInitials(p.name) || 'P';
          return (
            <button
              key={p.name}
              className={`gf-pop-item ${isActive ? 'active' : ''}`}
              onClick={() => handleSwitch(p.name)}
              disabled={switching !== null}
              style={{ background: 'transparent', border: 0, width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer' }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  background: isActive ? 'var(--gf)' : 'oklch(0.30 0.05 280)',
                  color: isActive ? 'var(--gf-ink)' : 'var(--ink-mute)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initials}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gf-pop-item-name">{p.name}</div>
                <div className="gf-pop-item-meta">
                  {count} mod{count === 1 ? '' : 's'}
                  {updateCount > 0 && ` · ${updateCount} update${updateCount === 1 ? '' : 's'}`}
                </div>
              </div>
              {switching === p.name ? (
                <RefreshCw size={12} className="animate-spin" style={{ color: 'var(--ink-mute)' }} />
              ) : isActive ? (
                <span className="gf-pill gf-pill-update">ACTIVE</span>
              ) : null}
            </button>
          );
        })
      )}
      <div className="gf-pop-foot">
        <button
          className="gf-btn-2 gf-btn-2-sm"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => { onClose(); onAddPack(); }}
        >
          <Plus size={11} /> Add pack
        </button>
        <button
          className="gf-btn-2 gf-btn-2-sm"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => { onClose(); onManageAll(); }}
        >
          Manage all
        </button>
      </div>
    </div>
  );
}
