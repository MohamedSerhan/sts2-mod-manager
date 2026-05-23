export interface ModInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  files: string[];
  source: string | null;
  hash: string | null;
  dependencies: string[];
  size_bytes: number;
  github_url: string | null;
  nexus_url: string | null;
  folder_name: string | null;
  mod_id: string | null;
  pinned: boolean;
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

export interface Profile {
  name: string;
  game_version: string | null;
  created_by: string | null;
  mods: ProfileMod[];
  created_at: string;
  updated_at: string;
  /** Opt-in flag for the in-app Browse Modpacks tab.
   *  true = listed; null / false = unlisted. */
  public?: boolean | null;
}

export interface ProfileMod {
  name: string;
  version: string;
  source: string | null;
  hash: string | null;
  files: string[];
  enabled: boolean;
  bundle_url: string | null;
  folder_name: string | null;
  mod_id: string | null;
}

export interface ProfileModOrderKey {
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
  name: string;
  editable: boolean;
}

export interface ProfileMembershipMod {
  name: string;
  version: string;
  folder_name: string | null;
  mod_id: string | null;
  display_name?: string | null;
  installed_enabled: boolean;
  profiles: ProfileMembershipState[];
}

export interface ProfileMembershipState {
  profile_name: string;
  included: boolean;
  enabled: boolean;
  editable: boolean;
}

export interface SwitchProfileResult {
  applied: boolean;
  missing_mods: string[];
  downloaded: number;
  failed_downloads: string[];
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
}

export interface ModSourceEntry {
  github_repo: string | null;
  nexus_url: string | null;
  nexus_game_domain: string | null;
  nexus_mod_id: number | null;
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
}

export interface AutoDetectResult {
  matched: AutoDetectMatch[];
  unmatched: string[];
  /** Mods skipped because they already had a GitHub or Nexus link.
   *  Surfaced so the modal can show "X already linked — nothing to detect"
   *  instead of three confusing zero badges. */
  skipped_already_linked?: number;
}

export interface AutoDetectMatch {
  mod_name: string;
  github_repo: string;
  confidence: string;
}

export interface Subscription {
  share_id: string;
  share_url: string;
  profile_name: string;
  curator: string | null;
  last_checked: string;
  last_synced: string;
}

export interface SubscriptionUpdate {
  share_id: string;
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
  mod_name: string;
  /** On-disk folder name for this mod. Used to disambiguate two installed
   *  mods that share a display name — pin/unpin keys by folder when present
   *  so the two same-named rows can be pinned independently. */
  folder_name?: string | null;
  github_repo: string | null;
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
}

export interface BrowserCard {
  owner: string;
  code: string;           // "AA5A-315D-61AE"
  name: string;
  mod_count: number;
  created_at: string;     // ISO
  updated_at: string;     // ISO
}

export interface BrowserPage {
  cards: BrowserCard[];
  page: number;
  has_next_page: boolean;
  stale: boolean;
  fetched_at: number;     // unix seconds
}
