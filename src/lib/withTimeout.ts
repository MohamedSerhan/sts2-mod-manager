/**
 * Race a promise against a timeout. Rejects with `Error(timeoutMessage)` if
 * `p` hasn't settled within `ms`; otherwise resolves/rejects with `p`. The
 * timer is always cleared so a slow-but-successful call doesn't leak it.
 *
 * Used to bound backend `invoke` calls that can stall on a slow/unreachable
 * network (the Tauri commands have per-request timeouts, but a large fan-out
 * can still chain those into minutes — this caps the wait the user sees).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
