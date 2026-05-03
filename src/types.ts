export interface ModInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  files: string[];
  source: string | null;
  hash: string | null;
  dependencies: string[];
}

export interface Profile {
  name: string;
  game_version: string;
  created_by: string;
  mods: ProfileMod[];
  created_at: string;
  updated_at: string;
}

export interface ProfileMod {
  name: string;
  version: string;
  source: string;
  hash: string | null;
  files: string[];
}

export interface GameInfo {
  path: string | null;
  version: string | null;
  mods_count: number;
}

export interface GitHubRepo {
  owner: string;
  name: string;
  full_name: string;
  description: string;
  stars: number;
  url: string;
  latest_version: string | null;
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
  download_url: string;
}

export interface NexusModInfo {
  mod_id: number;
  name: string;
  summary: string;
  version: string;
  author: string;
  category: string;
}

export interface ModUpdate {
  mod_name: string;
  current_version: string;
  latest_version: string;
  source: string;
  download_url: string;
}

export type QuickAddResult =
  | { type: 'github_installed'; mod_info: ModInfo }
  | { type: 'nexus_info'; nexus_info: NexusModInfo };

export interface ShareResult {
  id: string;
  url: string;
  secret_token: string;
}

export interface BackupInfo {
  name: string;
  timestamp: string;
  mod_count: number;
  size_bytes: number;
}
