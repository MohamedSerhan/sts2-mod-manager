/**
 * Guided 4-step modpack creator. Replaces the bare "name your profile"
 * inline form. The same component is also reachable from Home and from
 * the onboarding flow (wiring lives in those views — this file only
 * exposes the dialog and its onClose/onCreated callbacks).
 *
 *   Step 1 "Start"     — pick a starting strategy:
 *                          · From my active mods (default if any are enabled)
 *                          · Empty
 *                          · Clone an existing modpack (hidden when there
 *                            are none yet so we don't show a dead option)
 *
 *   Step 2 "Choose"    — pick mods with search + sort + per-row checkbox.
 *                        Selection is pre-populated from the chosen
 *                        strategy and preserved when the user navigates
 *                        Back/Next so they don't have to redo it.
 *
 *   Step 3 "Health"    — short summary of what's about to land based on
 *                        a single `audit_mod_versions` call. The numbers
 *                        come from the audit + the mod's github/nexus
 *                        link. Never mentions "GitHub" in the copy —
 *                        users who don't care about share flows shouldn't
 *                        be confronted with a GitHub-shaped concept here.
 *
 *   Step 4 "Finish"    — name + two create buttons. The only place we
 *                        mention GitHub is the one-line hint beside the
 *                        "Create and share now" button; the share flow
 *                        itself handles the token + repo setup later.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../contexts/AppContext';
import {
  auditModVersions,
  createProfile,
  listProfiles,
  setProfileModMembership,
} from '../hooks/useTauri';
import { withTimeout } from '../lib/withTimeout';
import { useModalA11y } from '../hooks/useModalA11y';
import { ModMultiSelect } from './ModMultiSelect';
import type { ModAuditEntry, Profile } from '../types';

/** Ceiling for the step-3 health audit. The audit is informational and
 *  non-blocking, so if GitHub/Nexus is slow we'd rather fall back to the
 *  "couldn't check" zeros than leave the step spinning forever. The user
 *  can also skip it outright via "Continue anyway". */
const AUDIT_TIMEOUT_MS = 20_000;

interface Props {
  onClose: () => void;
  /** Called once the new modpack is on disk and all membership rows are
   *  written. The parent decides what to do next (refresh + close, or
   *  open PublishModal if `sharedNow` is true). */
  onCreated: (result: { name: string; sharedNow: boolean }) => void;
}

type Step = 1 | 2 | 3 | 4;
type Strategy = 'fromActive' | 'empty' | 'clone';

interface HealthSummary {
  linked: number;
  updates: number;
  blocked: number;
  frozen: number;
}

export function CreateModpackWizard({ onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const { mods } = useApp();
  const [step, setStep] = useState<Step>(1);
  const [strategy, setStrategy] = useState<Strategy>('fromActive');
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  const [existingProfiles, setExistingProfiles] = useState<Profile[]>([]);
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  const [touchedSelection, setTouchedSelection] = useState(false);
  const [name, setName] = useState('');
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // Escape / focus-trap / initial focus. Gated while creating so a stray
  // Escape can't abort an in-flight write.
  useModalA11y(modalRef, onClose, !creating);

  // Load existing profiles so step 1 can decide whether to show the
  // Clone option. Fire-and-forget — if it fails (file system / IO),
  // the option just stays hidden, which is the safe fallback.
  useEffect(() => {
    let active = true;
    listProfiles()
      .then((ps) => { if (active) setExistingProfiles(ps); })
      .catch(() => { /* leave existingProfiles as [] */ });
    return () => { active = false; };
  }, []);

  // Default the strategy to whichever option makes sense given the
  // user's current state. If they have any active mods, "from active"
  // is the path with least surprise; otherwise "empty" wins.
  useEffect(() => {
    if (touchedSelection) return;
    if (mods.some((m) => m.enabled)) {
      setStrategy('fromActive');
    } else {
      setStrategy('empty');
    }
  }, [mods, touchedSelection]);

  // Apply the chosen strategy when leaving step 1 — this seeds
  // `selectedMods`. The strategy is committed by clicking the strategy
  // tile (one-click navigation: choosing also advances), which avoids
  // a redundant "Next" on a step that's already a single-choice screen.
  function applyStrategyAndAdvance(chosen: Strategy) {
    setStrategy(chosen);
    if (chosen === 'fromActive') {
      setSelectedMods(new Set(mods.filter((m) => m.enabled).map((m) => m.folder_name ?? m.name)));
    } else if (chosen === 'empty') {
      setSelectedMods(new Set());
    } else if (chosen === 'clone' && cloneFrom) {
      const target = existingProfiles.find((p) => p.name === cloneFrom);
      setSelectedMods(new Set(target ? target.mods.map((m) => m.folder_name ?? m.name) : []));
    } else {
      // clone strategy without a chosen profile — keep empty; the
      // step 1 Clone tile is disabled until cloneFrom is set so the
      // user shouldn't normally land here.
      setSelectedMods(new Set());
    }
    setTouchedSelection(true);
    setStep(2);
  }

  // Trigger the audit when the user advances to step 3. One-shot per
  // wizard run — no caching, no debouncing; the audit can take a
  // moment but the typical pack size makes it tolerable.
  async function goToHealth() {
    if (auditing) return; // guard against concurrent call (back-then-next race)
    setStep(3);
    setHealth(null);
    setAuditing(true);
    try {
      // Bound the audit: a large selection against a slow GitHub/Nexus
      // could otherwise spin "Checking…" indefinitely. On timeout we fall
      // through to the catch (zeros) so the step always resolves.
      // `selectedMods` is keyed by folder; the audit's `only` filter matches
      // by mod NAME, so translate the selection to names for the call. A
      // same-named twin may get audited too, but the folder-keyed filters
      // below only count the mods the user actually picked.
      const selectedNames = mods
        .filter((m) => selectedMods.has(m.folder_name ?? m.name))
        .map((m) => m.name);
      const entries: ModAuditEntry[] = await withTimeout(
        auditModVersions(selectedNames),
        AUDIT_TIMEOUT_MS,
        'audit timed out',
      );
      const isSelected = (folder: string | null | undefined, name: string) =>
        selectedMods.has(folder ?? name);
      const linked = mods.filter(
        (m) => isSelected(m.folder_name, m.name) && (m.github_url || m.nexus_url),
      ).length;
      const updates = entries.filter(
        (e) => e.needs_update && isSelected(e.folder_name, e.mod_name),
      ).length;
      const blocked = entries.filter(
        (e) => e.game_version_too_old === true && isSelected(e.folder_name, e.mod_name),
      ).length;
      const frozen = entries.filter(
        (e) => e.pinned && isSelected(e.folder_name, e.mod_name),
      ).length;
      setHealth({ linked, updates, blocked, frozen });
    } catch {
      // Audit failures are non-blocking — the user can still create
      // the pack. Surface zeros rather than hiding the section since
      // the layout shift would otherwise jump the Continue button.
      setHealth({ linked: 0, updates: 0, blocked: 0, frozen: 0 });
    } finally {
      setAuditing(false);
    }
  }

  // Final create: writes the manifest, then writes membership rows for
  // each selected mod. Sequential rather than parallel — the backend
  // serializes profile writes anyway and parallel calls would just
  // queue up. We resolve `onCreated` once the membership loop finishes.
  async function handleCreate(sharedNow: boolean) {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // createProfile snapshots the *entire* current install, so the new
      // pack starts with every installed mod. Prune everything the user
      // didn't pick — otherwise the pack silently contains all mods, not
      // just the selected ones. We prune from the returned snapshot (the
      // authoritative list of what actually landed) rather than the
      // frontend mod list.
      const created = await createProfile(trimmed);
      for (const pm of created.mods) {
        // Key by folder so a same-named twin the user DIDN'T pick is still
        // pruned (a name-keyed check would treat both as selected and leak it).
        if (selectedMods.has(pm.folder_name ?? pm.name)) continue;
        await setProfileModMembership(
          trimmed,
          pm.name,
          pm.folder_name ?? null,
          pm.mod_id ?? null,
          false,
        );
      }
      // Ensure every selected mod is present. Mostly a no-op (selected
      // mods are already in the snapshot), but it re-adds anything the
      // snapshot's compatibility filter dropped that the user explicitly
      // chose.
      for (const key of selectedMods) {
        const mod = mods.find((m) => (m.folder_name ?? m.name) === key);
        if (!mod) continue;
        await setProfileModMembership(
          trimmed,
          mod.name,
          mod.folder_name ?? null,
          mod.mod_id ?? null,
          true,
        );
      }
      onCreated({ name: trimmed, sharedNow });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const showCloneOption = existingProfiles.length > 0;
  const trimmedName = name.trim();
  const canCreate = trimmedName.length > 0 && !creating;

  // Labels for the shared checkbox picker (step 2).
  const modPickerLabels = {
    searchPlaceholder: t('createModpack.step2SearchPlaceholder'),
    sortLabel: t('createModpack.step2SortLabel'),
    sortByName: t('createModpack.step2SortByName'),
    sortBySize: t('createModpack.step2SortBySize'),
    sortByActive: t('createModpack.step2SortByEnabled'),
    selectedCount: (count: number) => t('createModpack.step2SelectedCount', { count }),
    selectAll: t('createModpack.step2SelectAll'),
    deselectAll: t('createModpack.step2DeselectAll'),
    noMods: t('createModpack.step2NoMods'),
  };

  return (
    <div
      className="gf-modal-back"
      onClick={creating ? undefined : onClose}
    >
      <div
        className="gf-modal gf-create-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gf-create-wizard-title"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div id="gf-create-wizard-title" className="gf-modal-title">{t('createModpack.title')}</div>
            <div className="gf-modal-sub">
              {step === 1 && t('createModpack.step1Subtitle')}
              {step === 2 && t('createModpack.step2Subtitle')}
              {step === 3 && t('createModpack.step3Subtitle')}
              {step === 4 && t('createModpack.step4Subtitle')}
            </div>
          </div>
          <div className="gf-create-wizard-step-indicator" aria-hidden="true">
            {step} / 4
          </div>
        </div>

        <div className="gf-modal-body">
          {step === 1 && (
            <StepStart
              strategy={strategy}
              setStrategy={setStrategy}
              showCloneOption={showCloneOption}
              existingProfiles={existingProfiles}
              cloneFrom={cloneFrom}
              setCloneFrom={setCloneFrom}
              onPick={applyStrategyAndAdvance}
            />
          )}
          {step === 2 && (
            <ModMultiSelect
              mods={mods}
              selected={selectedMods}
              onChange={setSelectedMods}
              labels={modPickerLabels}
            />
          )}
          {step === 3 && (
            <StepHealth auditing={auditing} health={health} />
          )}
          {step === 4 && (
            <StepFinish
              name={name}
              setName={setName}
              creating={creating}
              error={createError}
            />
          )}
        </div>

        <div className="gf-modal-foot">
          <button
            type="button"
            className="gf-btn-3"
            onClick={onClose}
            disabled={creating}
          >
            {t('createModpack.cancel')}
          </button>
          <div style={{ flex: 1 }} />
          {step > 1 && (
            <button
              type="button"
              className="gf-btn-2"
              onClick={() => setStep((s) => (s - 1) as Step)}
              disabled={creating}
            >
              {t('createModpack.back')}
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              className="gf-btn"
              onClick={goToHealth}
            >
              {t('createModpack.next')}
            </button>
          )}
          {step === 3 && (
            // Not disabled while auditing: the check is informational, so
            // "Continue anyway" must always let the user move on — never
            // trap them behind a slow/stalled audit.
            <button
              type="button"
              className="gf-btn"
              onClick={() => setStep(4)}
            >
              {t('createModpack.step3ContinueAnyway')}
            </button>
          )}
          {step === 4 && (
            <>
              <button
                type="button"
                className="gf-btn-2"
                onClick={() => handleCreate(true)}
                disabled={!canCreate}
              >
                {creating
                  ? t('createModpack.step4Creating')
                  : t('createModpack.step4ShareNowBtn')}
              </button>
              <button
                type="button"
                className="gf-btn"
                onClick={() => handleCreate(false)}
                disabled={!canCreate}
              >
                {creating
                  ? t('createModpack.step4Creating')
                  : t('createModpack.step4CreateBtn')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step 1: Start ─────────────────────────────────────────────────────

interface StepStartProps {
  strategy: Strategy;
  setStrategy: (s: Strategy) => void;
  showCloneOption: boolean;
  existingProfiles: Profile[];
  cloneFrom: string | null;
  setCloneFrom: (n: string | null) => void;
  /** Commits a strategy and advances to step 2. Step 1 uses one-click
   *  navigation so the user doesn't have to confirm a single-choice
   *  decision with a separate Next button. */
  onPick: (s: Strategy) => void;
}

function StepStart({
  strategy,
  setStrategy,
  showCloneOption,
  existingProfiles,
  cloneFrom,
  setCloneFrom,
  onPick,
}: StepStartProps) {
  const { t } = useTranslation();
  return (
    <div className="gf-create-wizard-strategy">
      <StrategyOption
        active={strategy === 'fromActive'}
        title={t('createModpack.step1FromActive')}
        desc={t('createModpack.step1FromActiveDesc')}
        onClick={() => onPick('fromActive')}
      />
      <StrategyOption
        active={strategy === 'empty'}
        title={t('createModpack.step1Empty')}
        desc={t('createModpack.step1EmptyDesc')}
        onClick={() => onPick('empty')}
      />
      {showCloneOption && (
        <>
          <StrategyOption
            active={strategy === 'clone'}
            title={t('createModpack.step1Clone')}
            desc={t('createModpack.step1CloneDesc')}
            // Clone needs a follow-up selection (which existing pack?) so
            // it can't be a one-click commit. We only set the strategy
            // here; advancing happens via the dedicated dropdown + button.
            onClick={() => setStrategy('clone')}
          />
          {strategy === 'clone' && (
            <div className="gf-create-wizard-clone-pick">
              <label
                htmlFor="gf-create-wizard-clone-pick"
                className="gf-field-label"
              >
                {t('createModpack.step1CloneSelectLabel')}
              </label>
              <select
                id="gf-create-wizard-clone-pick"
                className="gf-set-input"
                value={cloneFrom ?? ''}
                onChange={(e) => setCloneFrom(e.target.value || null)}
              >
                <option value="">—</option>
                {existingProfiles.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="gf-btn"
                style={{ marginTop: 8, alignSelf: 'flex-end' }}
                disabled={!cloneFrom}
                onClick={() => onPick('clone')}
              >
                {t('createModpack.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StrategyOption({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`gf-create-wizard-strategy-option ${active ? 'is-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="gf-create-wizard-strategy-title">{title}</span>
      <span className="gf-create-wizard-strategy-desc">{desc}</span>
    </button>
  );
}

// ── Step 3: Check health ──────────────────────────────────────────────

function StepHealth({
  auditing,
  health,
}: {
  auditing: boolean;
  health: HealthSummary | null;
}) {
  const { t } = useTranslation();
  if (auditing || !health) {
    return (
      <div className="gf-create-wizard-health-loading">
        {t('createModpack.step3Checking')}
      </div>
    );
  }
  return (
    <ul className="gf-create-wizard-health-list">
      <li>{t('createModpack.step3Linked', { count: health.linked })}</li>
      <li>{t('createModpack.step3Updates', { count: health.updates })}</li>
      <li>{t('createModpack.step3Blocked', { count: health.blocked })}</li>
      <li>{t('createModpack.step3Frozen', { count: health.frozen })}</li>
    </ul>
  );
}

// ── Step 4: Finish ────────────────────────────────────────────────────

function StepFinish({
  name,
  setName,
  creating,
  error,
}: {
  name: string;
  setName: (n: string) => void;
  creating: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="gf-create-wizard-finish">
      <div className="gf-field">
        <label htmlFor="gf-create-wizard-name" className="gf-field-label">
          {t('createModpack.step4NameLabel')}
        </label>
        <input
          id="gf-create-wizard-name"
          type="text"
          className="gf-set-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('createModpack.step4NamePlaceholder')}
          aria-label={t('createModpack.step4NameLabel')}
          disabled={creating}
        />
      </div>
      <div className="gf-create-wizard-share-hint">
        {t('createModpack.step4ShareHint')}
      </div>
      {error && (
        <div className="gf-create-wizard-error" role="alert">
          {t('createModpack.createFailed', { error })}
        </div>
      )}
    </div>
  );
}
