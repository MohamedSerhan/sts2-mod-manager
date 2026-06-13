import { describe, expect, it, vi } from 'vitest';

import type { SwitchProfileResult } from '../types';
import { switchResultDetails, switchResultHasProblems } from './switchResultSummary';

const baseResult = (overrides: Partial<SwitchProfileResult> = {}): SwitchProfileResult => ({
  applied: true,
  downloaded: 0,
  missing_mods: [],
  failed_downloads: [],
  replaced_mods: [],
  replace_failures: [],
  failed_enables: [],
  ...overrides,
});

describe('switchResultSummary', () => {
  it('treats missing, failed, replace, and enable failures as problems', () => {
    expect(switchResultHasProblems(baseResult())).toBe(false);
    expect(switchResultHasProblems(baseResult({ missing_mods: ['A'] }))).toBe(true);
    expect(switchResultHasProblems(baseResult({ failed_downloads: ['A'] }))).toBe(true);
    expect(switchResultHasProblems(baseResult({ replace_failures: ['A'] }))).toBe(true);
    expect(switchResultHasProblems(baseResult({ failed_enables: ['A'] }))).toBe(true);
  });

  it('summarizes detailed and compact partial-failure messages', () => {
    const t = vi.fn((key: string, opts?: Record<string, unknown>) => `${key}:${opts?.count ?? ''}:${opts?.list ?? ''}`);
    const result = baseResult({
      downloaded: 2,
      failed_downloads: ['A'],
      missing_mods: ['B'],
      replaced_mods: ['C'],
      replace_failures: ['D'],
      failed_enables: ['E'],
    });

    expect(switchResultDetails(result, t as any)).toEqual([
      'common.parts.modsDownloaded:2:',
      'common.parts.failedWithList:1:A',
      'common.parts.stillMissingWithList:1:B',
      'common.parts.replacedWithList:1:C',
      'common.parts.replaceFailedWithList:1:D',
      'common.parts.enableFailedWithList:1:E',
    ]);
    expect(switchResultDetails(result, t as any, { includeLists: false })).toContain('common.parts.failed:1:');
    expect(switchResultDetails(result, t as any, { includeLists: false })).toContain('common.parts.enableFailed:1:');
  });
});
