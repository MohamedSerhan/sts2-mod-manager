export const AUTO_ADD_INSTALLS_TO_MODPACK_KEY = 'sts2mm-auto-add-installs-to-modpack';

function getStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadAutoAddInstallsToModpack(storage?: Storage | null): boolean {
  return getStorage(storage)?.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY) !== 'false';
}

export function saveAutoAddInstallsToModpack(
  enabled: boolean,
  storage?: Storage | null,
): void {
  getStorage(storage)?.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, enabled ? 'true' : 'false');
}
