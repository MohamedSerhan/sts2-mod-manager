import { getVersion } from '@tauri-apps/api/app';

/** True when the running build is a dev build (its version contains "-dev",
 *  e.g. "1.6.1-dev.pr59.g837f5ba"). Used to gate the Dev Builds UI and to
 *  suppress the release update-nag on dev builds. Resolves false if the
 *  version can't be read. */
export async function isDevBuild(): Promise<boolean> {
  try {
    return (await getVersion()).includes('-dev');
  } catch {
    return false;
  }
}
