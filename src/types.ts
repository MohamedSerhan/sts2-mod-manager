export type ModInstallSource = 'local' | 'steam_workshop';

export interface ModInfo {
  mod_version_id?: string | null;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  files: string[];
  source: string | null;
  install_source?: ModInstallSource;
  workshop_item_id?: string | null;
  workshop_url?: string | null;
  workshop_manifest?: string | null;
  workshop_time_updated?: number | null;
  workshop_update_pending?: boolean;
  hash: string | null;
  dependencies: string[];
  size_bytes: number;
  github_url: string | null;
  /** True when the GitHub URL came from manager auto-detection rather than
   *  a user-confirmed/manual source link. Inline update promotes the repo
   *  before use; audit/repair paths keep treating it as lower-confidence. */
  github_auto_detected?: boolean;
  nexus_url: string | null;
  folder_name: string | null;
  mod_id: string | null;
  pinned: boolean;
  /** Display names of the individual mods bundled inside this container.
   *  Non-empty only when this ModInfo represents the single library entry
   *  for a multi-mod (bundle) download. Empty / absent for normal mods. */
  bundle_members?: string[];
  /** Game runtime IDs of the bundled member mods. */
  bundle_member_ids?: string[];
  /** Minimum STS2 build the mod's manifest declares (e.g. "0.105.0").
   *  null when the mod doesn't care about game version. */
  min_game_version?: string | null;
  /** Author from the manifest, used as a disambiguation subtitle when
   *  two installed mods share a display name. null when the manifest
   *  didn't declare one. */
  author?: string | null;
  /** Free-form user note saved to mod_sources.json. Shown on the mod row
   *  so the user can remember where the mod came from (e.g. "downloaded
   *  from Patreon") or other context. */
  note?: string | null;
  /** User-saved non-GitHub/non-Nexus URL (Patreon, X, Discord, etc).
   *  Shown as an external-link chip alongside GitHub/Nexus on the row. */
  custom_url?: string | null;
  /** User-owned organization tags/categories. These are manager-only labels
   *  and never participate in mod identity, updates, or profile matching. */
  tags?: string[];
  /** User-facing label override. The manifest name remains in `name`. */
  display_name?: string | null;
  /** User-facing description override. The manifest description remains
   *  in `description`. */
  display_description?: string | null;
}

/** Curator-authored per-mod metadata carried inside a shared manifest
 *  (notes / custom link / tags). Merged fill-only into the receiver's
 *  mod_sources on install — their own annotations always win. */
export interface SharedModExtras {
  note?: string | null;
  custom_url?: string | null;
  tags?: string[];
}

export interface Profile {
  id: string;
  name: string;
  game_version: string | null;
  created_by: string | null;
  mods: ProfileMod[];
  created_at: string;
  updated_at: string;
  /** Opt-in flag for the in-app Browse Modpacks tab.
   *  true = listed; null / false = unlisted. */
  public?: boolean | null;
  /** Curator notes/links/tags per mod, keyed `folder_name ?? name`.
   *  Present only on manifests published with "Include notes" on. */
  mod_extras?: Record<string, SharedModExtras>;
}

export interface ProfileMod {
  mod_version_id?: string | null;
  name: string;
  version: string;
  source: string | null;
  hash: string | null;
  files: string[];
  enabled: boolean;
  bundle_url: string | null;
  bundle_sha256?: string | null;
  folder_name: string | null;
  mod_id: string | null;
  /** Member-mod display names when this entry is a bundle container.
   *  Non-empty only when the installed mod had bundle_members set.
   *  Absent / empty for normal mods and legacy manifests. */
  bundle_members?: string[];
  /** Game runtime IDs of the bundled member mods. */
  bundle_member_ids?: string[];
}

export interface ProfileModOrderKey {
  mod_version_id?: string | null;
  name: string;
  folder_name: string | null;
  mod_id: string | null;
}

export type LoadOrderSettingsStatus =
  | 'applied'
  | 'skipped_inactive'
  | 'skipped_missing'
  | 'skipped_multiple'
  | 'skipped_game_running'
  | 'failed';

export interface ProfileLoadOrderUpdate {
  profile: Profile;
  settings_status: LoadOrderSettingsStatus;
  settings_path: string | null;
}

export interface ProfileMembershipGrid {
  profiles: ProfileMembershipProfile[];
  mods: ProfileMembershipMod[];
}

export interface ProfileMembershipProfile {
  id?: string;
  name: string;
  editable: boolean;
}

export interface ProfileMembershipMod {
  mod_version_id?: string | null;
  name: string;
  version: string;
  folder_name: string | null;
  mod_id: string | null;
  display_name?: string | null;
  source?: string | null;
  github_url?: string | null;
  nexus_url?: string | null;
  install_source?: ModInstallSource;
  workshop_item_id?: string | null;
  workshop_url?: string | null;
  workshop_time_updated?: number | null;
  workshop_update_pending?: boolean;
  bundle_members?: string[];
  bundle_member_ids?: string[];
  installed?: boolean;
  cached?: boolean;
  missing?: boolean;
  installed_enabled: boolean;
  version_options?: LocalModVersionOption[];
  profiles: ProfileMembershipState[];
}

export interface LocalModVersionOption {
  mod_version_id: string;
  name: string;
  version: string;
  folder_name?: string | null;
  mod_id?: string | null;
  display_name?: string | null;
  source?: string | null;
  github_url?: string | null;
  nexus_url?: string | null;
  install_source?: ModInstallSource;
  workshop_item_id?: string | null;
  workshop_url?: string | null;
  bundle_member_ids?: string[];
  installed: boolean;
  installed_enabled: boolean;
  cached: boolean;
  pinned: boolean;
  used_by_profiles?: string[];
}

export interface LocalModVersionAffectedProfile {
  profile_id: string;
  profile_name: string;
}

export interface LocalModVersionRemovalPreview {
  target: LocalModVersionOption;
  affected_profiles: LocalModVersionAffectedProfile[];
  replacement_candidates: LocalModVersionOption[];
  active: boolean;
  installed: boolean;
  cached: boolean;
  pinned: boolean;
  can_delete_directly: boolean;
}

export type ManualModVersionRemovalMode = 'remap' | 'remove_from_packs';

export interface ManualModVersionProfileReplacement {
  profile_id: string;
  mod_version_id: string;
}

export interface ManualModVersionRemovalResult {
  removed_mod_version_id: string;
  mode: ManualModVersionRemovalMode;
  remapped_profiles?: LocalModVersionAffectedProfile[];
  removed_profiles?: LocalModVersionAffectedProfile[];
  switched_active: boolean;
  deleted_disk: boolean;
  deleted_cache: boolean;
  removed_record: boolean;
}

export interface ProfileMembershipState {
  profile_id?: string;
  profile_name: string;
  included: boolean;
  enabled: boolean;
  editable: boolean;
  order_index?: number | null;
}

export interface SwitchProfileResult {
  applied: boolean;
  missing_mods: string[];
  downloaded: number;
  failed_downloads: string[];
  /** Mods whose mismatched on-disk copy was replaced with the profile's
   *  version (non-destructively). Surfaced by name in the toast. */
  replaced_mods?: string[];
  /** Mods whose update/replace failed; the old on-disk version was rolled
   *  back and kept, so they are not lost (vs. `failed_downloads`). */
  replace_failures?: string[];
  /** Mods that were present for the pack but could not be activated after retries. */
  failed_enables?: string[];
}

/** Result of bulk enable/disable of a modpack's mods. */
export interface SetProfileModsEnabledResult {
  enabled: boolean;
  /** Display names of mods actually moved into the requested state. */
  toggled: string[];
  /** Pack mods with no matching installed mod (can't be toggled). */
  missing: string[];
  /** Matched mods whose move failed. */
  failed: string[];
}

export type LaunchFailureReason =
  | 'reflection_type_load'
  | 'missing_method'
  | 'missing_dependency'
  | 'assembly_init'
  | 'critical_patch'
  | 'load_failed';

export interface LaunchFailureMod {
  name: string;
  display_name?: string | null;
  version: string;
  folder_name?: string | null;
  mod_id?: string | null;
  reasons: LaunchFailureReason[];
}

export interface LaunchDiagnostics {
  log_path?: string | null;
  game_version?: string | null;
  failed_mods: LaunchFailureMod[];
}

export interface LaunchIncompatibleMod {
  name: string;
  display_name?: string | null;
  version: string;
  folder_name?: string | null;
  mod_id?: string | null;
  min_game_version: string;
}

export interface LaunchDependencyBlockedMod {
  name: string;
  display_name?: string | null;
  version: string;
  folder_name?: string | null;
  mod_id?: string | null;
  missing_dependencies: string[];
}

export interface LaunchHealthReport {
  active_profile_id?: string | null;
  active_profile_name?: string | null;
  current_game_version?: string | null;
  last_launch_game_version?: string | null;
  profile_game_version?: string | null;
  game_version_changed_since_last_launch: boolean;
  profile_game_version_changed: boolean;
  known_incompatible_mods: LaunchIncompatibleMod[];
  dependency_blocked_mods: LaunchDependencyBlockedMod[];
  previous_failed_mods: LaunchFailureMod[];
}

export interface LaunchQuarantinedMod {
  name: string;
  folder_name?: string | null;
  mod_id?: string | null;
  destination?: string | null;
}

export interface LaunchQuarantineFailure {
  name: string;
  folder_name?: string | null;
  error: string;
}

export interface LaunchQuarantineResult {
  active_profile_id?: string | null;
  moved: LaunchQuarantinedMod[];
  disabled_profile_entries: LaunchQuarantinedMod[];
  failed: LaunchQuarantineFailure[];
}

export interface RepairProfileResult extends SwitchProfileResult {
  /** Active mods that were not in the profile manifest and were moved to
   *  mods_disabled as part of repair. */
  disabled_orphans?: string[];
  /** Deprecated compatibility field. Repair no longer deletes orphans. */
  deleted_orphans: string[];
}

export interface GameInfo {
  game_path: string | null;
  mods_path: string | null;
  disabled_mods_path: string | null;
  mods_count: number;
  disabled_count: number;
  valid: boolean;
  /** STS2 build version (e.g. "0.103.2") parsed from release_info.json
   *  in the game's install directory. `null` if the file is missing or
   *  the field couldn't be read — UI falls back to "unknown" in that case. */
  game_version?: string | null;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  owner: { login: string; avatar_url: string };
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface NexusModInfo {
  mod_id: number;
  name: string | null;
  summary: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  category_id: number | null;
  picture_url: string | null;
}

export interface ModUpdate {
  mod_name: string;
  current_version: string;
  latest_version: string;
  source_type: string;
  source_id: string;
  download_url: string;
}

export type QuickAddResult =
  | { type: 'github_installed'; mod_info: ModInfo }
  | { type: 'nexus_info'; nexus_info: NexusModInfo };

export interface ShareResult {
  code: string;
  owner: string;
  file_path: string;
  /** URL to the published profile manifest on GitHub. */
  url: string;
  /** URL of the `sts2mm-profiles` repo the manager auto-created on the
   *  curator's GitHub. Surfaced so the curator can see exactly what
   *  was created (and visit it to delete / make private if they want). */
  repo_url: string;
  /** Names of mods whose bundle upload to the profiles repo failed.
   *  Friends installing this share code will see "missing mod" entries
   *  for these. Surfaced in a toast so the curator knows to retry. */
  failed_uploads: string[];
  /** True when this pack was last published under an older share format
   *  than the app now produces, so re-sharing would improve it (e.g. add
   *  source links the old manifest lacked). Only set by `getShareInfo`
   *  (the status read); a fresh share/reshare leaves it false. Drives the
   *  "Re-share recommended" nudge in the Profiles view. Optional so older
   *  cached results / tests without the field don't break. */
  reshare_recommended?: boolean;
  /** True when local changes have not been pushed to the published share yet. */
  out_of_sync?: boolean;
}

export interface ModSourceEntry {
  github_repo: string | null;
  nexus_url: string | null;
  nexus_game_domain: string | null;
  nexus_mod_id: number | null;
  workshop_url?: string | null;
  workshop_item_id?: string | null;
  note?: string | null;
  custom_url?: string | null;
  tags?: string[];
  display_name?: string | null;
  display_description?: string | null;
  snoozed_until_tag?: string | null;
  /** SHA256 of each tracked config file at install time. Backend-only
   *  bookkeeping driving the post-update "preserved N files" toast —
   *  frontend doesn't read this directly. */
  config_hashes?: Record<string, string>;
  installed_version?: string | null;
  installed_version_source?:
    | 'github'
    | 'nexus'
    | 'manual'
    | 'unknown'
    | string
    | null;
}

export interface AutoDetectResult {
  matched: AutoDetectMatch[];
  unmatched: string[];
  /** Mods skipped because they already had a GitHub or Nexus link.
   *  Surfaced so the modal can show "X already linked — nothing to detect"
   *  instead of three confusing zero badges. */
  skipped_already_linked?: number;
  /** true when GitHub's search quota was exhausted mid-run.
   *  When true, `not_checked` contains mods that were NOT searched —
   *  they must NOT be shown as "no candidates". */
  rate_limited?: boolean;
  /** Unix timestamp (seconds) when the GitHub search quota resets.
   *  Only meaningful when rate_limited is true. */
  rate_limit_reset_at?: number | null;
  /** Mods whose search was abandoned due to rate-limiting.
   *  Distinct from `unmatched` — these weren't searched, not "no match". */
  not_checked?: string[];
  /** Whether an authenticated GitHub token was used for this run. */
  authenticated?: boolean;
}

export interface AutoDetectMatch {
  mod_name: string;
  github_repo: string;
  confidence: string;
}

export interface Subscription {
  share_id: string;
  share_url: string;
  profile_id?: string;
  profile_name: string;
  curator: string | null;
  last_checked: string;
  last_synced: string;
}

export interface SubscriptionUpdate {
  share_id: string;
  profile_id?: string;
  profile_name: string;
  has_update: boolean;
  added_mods: string[];
  removed_mods: string[];
  updated_mods: ModVersionChange[];
  remote_profile: Profile | null;
}

export interface ModVersionChange {
  name: string;
  old_version: string;
  new_version: string;
}

export interface BackupInfo {
  name: string;
  timestamp: string;
  mod_count: number;
  size_bytes: number;
}

export interface ModAuditEntry {
  /** Stable installed-artifact identity when the backend can resolve one. */
  mod_version_id?: string | null;
  mod_name: string;
  /** On-disk folder name for this mod. Used to disambiguate two installed
   *  mods that share a display name — pin/unpin keys by folder when present
   *  so the two same-named rows can be pinned independently. */
  folder_name?: string | null;
  github_repo: string | null;
  /** Version declared by the installed mod's manifest on disk. */
  manifest_version?: string | null;
  /** Version/tag the manager last installed from a trusted source. This can
   *  differ from manifest_version when the upstream manifest is stale. */
  installed_source_version?: string | null;
  /** Legacy display/update field. Prefer manifest_version and
   *  installed_source_version for new UI. */
  installed_version: string;
  latest_release_tag: string | null;
  latest_release_with_assets_tag: string | null;
  latest_has_assets: boolean;
  needs_update: boolean;
  asset_names: string[];
  releases_scanned: number;
  error: string | null;
  nexus_url: string | null;
  nexus_version: string | null;
  nexus_update_available: boolean;
  update_source: string | null;
  github_auto_detected: boolean;
  pinned: boolean;
  /** Minimum game version this mod's manifest declares, if any. */
  min_game_version?: string | null;
  /** True iff `min_game_version` exists and the user's detected game
   *  version is below it — the game won't load this mod until they
   *  update their STS2 install or switch beta branches. */
  game_version_too_old?: boolean;
  /** `min_game_version` declared by the latest GitHub release with
   *  installable assets. Read from the release zip's manifest during
   *  audit. None = the release didn't declare one. */
  latest_release_min_game_version?: string | null;
  /** True iff the latest release with assets requires a newer game
   *  version than the user has — clicking Update will walk back to an
   *  older compatible release rather than installing the latest. */
  latest_release_blocked_by_game_version?: boolean;
  /** The tag the Update button will actually install (the newest
   *  release whose `min_game_version` is satisfied by the user's
   *  game). When `latest_release_blocked_by_game_version` is true,
   *  this names the older fallback so the UI can preview it. */
  latest_compatible_tag?: string | null;
  /** True when the user snoozed update suggestions for this mod at its
   *  current `latest_release_with_assets_tag`. Auto-expires when the
   *  upstream tag advances. Distinct from `pinned`: snooze suppresses
   *  the "update available" badge but doesn't block manual updates. */
  snoozed?: boolean;
  update_plans?: UpdatePlanItem[];
}

export type UpdateAcquisitionCapability = 'downloadable' | 'manual' | 'steam-managed' | 'frozen';

export interface UpdatePlanItem {
  target: ModAuditTarget;
  current_version: string;
  target_version: string | null;
  provider: 'github' | 'nexus' | 'steam' | string;
  source: string | null;
  capability: UpdateAcquisitionCapability;
  reason: string;
  selectable: boolean;
  pending: boolean;
}

export interface UpdatePlanSelection {
  target: ModAuditTarget;
  expected_version: string;
  provider: string;
}

export interface UpdateApplyResult {
  target: ModAuditTarget;
  mod_name: string;
  expected_version: string;
  actual_version: string | null;
  status: 'updated' | 'stale' | 'skipped' | 'failed';
  message: string | null;
  updated_mod: ModInfo | null;
}

export interface ModAuditTarget {
  mod_version_id?: string | null;
  folder_name?: string | null;
  mod_id?: string | null;
  install_source?: ModInstallSource;
  workshop_item_id?: string | null;
  workshop_url?: string | null;
  name: string;
}

export interface BrowserCard {
  owner: string;
  code: string; // "AA5A-315D-61AE"
  name: string;
  mod_count: number;
  created_at: string; // ISO
  updated_at: string; // ISO
}

export interface BrowserPage {
  cards: BrowserCard[];
  page: number;
  has_next_page: boolean;
  stale: boolean;
  fetched_at: number; // unix seconds
}
