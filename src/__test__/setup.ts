/**
 * Vitest setup file. Loads once per test file before tests run.
 *
 * Responsibilities:
 *   1. Extend `expect` with `@testing-library/jest-dom` matchers
 *      (toBeInTheDocument, toHaveAttribute, etc.).
 *   2. Mock the Tauri SDK so React components can call
 *      `invoke`/`listen` without a real Tauri runtime. Tests register
 *      per-command handlers via `registerInvokeHandler`.
 *   3. Reset mocks between tests so one spec can't leak into another.
 *
 * The mock is intentionally minimal — it covers the surface the
 * frontend actually uses today (invoke + event listen + opener
 * plugin). Add to it as needed when a new component reaches further.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '../i18n';

// ── Tauri mock plumbing ────────────────────────────────────────────

type InvokeHandler = (args: Record<string, unknown> | undefined) => unknown | Promise<unknown>;

const invokeHandlers = new Map<string, InvokeHandler>();
const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
let invokeFallback: InvokeHandler | null = null;

/** Register (or replace) a handler for a single Tauri command. */
export function registerInvokeHandler(cmd: string, handler: InvokeHandler): void {
  invokeHandlers.set(cmd, handler);
}

/** Register a fallback for commands without a specific handler. */
export function registerInvokeFallback(handler: InvokeHandler | null): void {
  invokeFallback = handler;
}

/** Inspect all invoke calls made since the last reset. Use this to
 *  assert the frontend called the right command with the right args. */
export function getInvokeCalls(): ReadonlyArray<{ cmd: string; args: Record<string, unknown> | undefined }> {
  return invokeCalls;
}

/** Clear handlers + call log. Runs automatically between tests so
 *  each test starts with a clean slate. */
export function resetTauriMocks(): void {
  invokeHandlers.clear();
  invokeCalls.length = 0;
  invokeFallback = null;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    const handler = invokeHandlers.get(cmd);
    if (handler) return await handler(args);
    if (invokeFallback) return await invokeFallback(args);
    // No handler registered → return null so frontend code that does
    // `result ?? defaultValue` doesn't crash. Tests that care about
    // a specific command MUST register a handler for it.
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, _handler: (...args: unknown[]) => void) => {
    // Returns an unlisten function. Real listeners aren't invoked by
    // the mock — tests that need event delivery can grab the handler
    // from listen.mock.calls and call it manually.
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
  openPath: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => {}),
  ask: vi.fn(async () => false),
  confirm: vi.fn(async () => false),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  exit: vi.fn(async () => {}),
  relaunch: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));

let mockAppVersion = '1.3.4';

/** Override the app version reported by `@tauri-apps/api/app::getVersion`. */
export function setMockAppVersion(v: string): void {
  mockAppVersion = v;
}

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => mockAppVersion),
  getName: vi.fn(async () => 'sts2-mod-manager'),
  getTauriVersion: vi.fn(async () => '2.0.0'),
}));

// jsdom doesn't implement scrollIntoView — provide a no-op stub so
// effects that call it (e.g. Home's focusCodeBarSignal scroll) don't
// crash the test. Real users get the actual scroll.
if (typeof window !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

/**
 * Sensible defaults for the most-called read-only Tauri commands.
 * Without these, AppContext.refreshAll() poisons descendant components
 * with `null` for the mod array etc., crashing any test that mounts a
 * subtree under <AppProvider>. Tests can still override individual
 * commands via registerInvokeHandler.
 */
function registerSafeDefaults(): void {
  invokeHandlers.set('get_installed_mods', () => []);
  invokeHandlers.set('get_game_info', () => ({
    game_path: null,
    mods_path: null,
    disabled_mods_path: null,
    mods_count: 0,
    disabled_count: 0,
    valid: false,
    game_version: null,
  }));
  invokeHandlers.set('is_game_running_cmd', () => false);
  invokeHandlers.set('check_subscription_updates', () => []);
  invokeHandlers.set('list_profiles_cmd', () => []);
  invokeHandlers.set('get_profile_memberships', () => ({ profiles: [], mods: [] }));
  invokeHandlers.set('set_profile_load_order', () => ({
    profile: null,
    settings_status: 'skipped_inactive',
    settings_path: null,
  }));
  invokeHandlers.set('get_subscriptions', () => []);
  invokeHandlers.set('get_active_profile', () => null);
  invokeHandlers.set('get_mod_sources', () => ({}));
  invokeHandlers.set('get_api_key_status', () => ({
    nexus_api_key_set: false,
    github_token_set: false,
  }));
  invokeHandlers.set('get_launch_mode', () => 'steam');
  invokeHandlers.set('list_backups_cmd', () => []);
  invokeHandlers.set('detect_game_path', () => ({
    game_path: null,
    mods_path: null,
    disabled_mods_path: null,
    mods_count: 0,
    disabled_count: 0,
    valid: false,
    game_version: null,
  }));
  invokeHandlers.set('audit_mod_versions', () => []);
  invokeHandlers.set('check_for_updates', () => []);
  invokeHandlers.set('search_github_mods', () => []);
  invokeHandlers.set('nexus_get_trending', () => []);
  invokeHandlers.set('nexus_get_latest_added', () => []);
  invokeHandlers.set('get_log_path', () => '');
  invokeHandlers.set('read_log_tail', () => '');
  invokeHandlers.set('open_external_url', async (args) => {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(String(args?.url ?? ''));
    return true;
  });
}

// ── Per-test cleanup ───────────────────────────────────────────────

beforeEach(async () => {
  resetTauriMocks();
  registerSafeDefaults();
  // Components like ModsView persist UI prefs ("sts2mm-mods-advanced",
  // "sts2mm-onboarded", etc.) to localStorage. jsdom shares one
  // Storage instance across the whole test file, so an early test that
  // toggles a preference leaks into later tests that expect the
  // default state. Clear before every test to keep them independent.
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
  await i18n.changeLanguage('en');
});

afterEach(() => {
  // React Testing Library auto-cleanup. Without this, components
  // from one test linger in the DOM and queries see them in the next.
  cleanup();
});
