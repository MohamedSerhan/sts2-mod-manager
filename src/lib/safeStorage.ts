/**
 * Returns localStorage, or undefined when it is absent or even *touching*
 * it throws (private modes, stripped/embedded webviews). Mirrors the guard
 * in theme.ts so preference modules degrade instead of crashing.
 */
export function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
