import type { TFunction } from 'i18next';
import type { SwitchProfileResult } from '../types';

export function switchResultDetails(
  result: SwitchProfileResult,
  t: TFunction,
  options: { includeLists?: boolean } = {},
): string[] {
  const includeLists = options.includeLists ?? true;
  const parts: string[] = [];
  if (result.downloaded > 0) {
    parts.push(t('common.parts.modsDownloaded', { count: result.downloaded }));
  }
  if (result.failed_downloads?.length > 0) {
    parts.push(
      includeLists
        ? t('common.parts.failedWithList', {
            count: result.failed_downloads.length,
            list: result.failed_downloads.join(', '),
          })
        : t('common.parts.failed', { count: result.failed_downloads.length }),
    );
  }
  if (result.missing_mods.length > 0) {
    parts.push(
      includeLists
        ? t('common.parts.stillMissingWithList', {
            count: result.missing_mods.length,
            list: result.missing_mods.join(', '),
          })
        : t('common.parts.stillMissing', { count: result.missing_mods.length }),
    );
  }
  if (result.replaced_mods?.length) {
    parts.push(
      t('common.parts.replacedWithList', {
        count: result.replaced_mods.length,
        list: result.replaced_mods.join(', '),
      }),
    );
  }
  if (result.replace_failures?.length) {
    parts.push(
      t('common.parts.replaceFailedWithList', {
        count: result.replace_failures.length,
        list: result.replace_failures.join(', '),
      }),
    );
  }
  if (result.failed_enables?.length) {
    parts.push(
      includeLists
        ? t('common.parts.enableFailedWithList', {
            count: result.failed_enables.length,
            list: result.failed_enables.join(', '),
          })
        : t('common.parts.enableFailed', { count: result.failed_enables.length }),
    );
  }
  return parts;
}

export function switchResultHasProblems(result: SwitchProfileResult): boolean {
  return (result.failed_downloads?.length ?? 0) > 0
    || (result.missing_mods?.length ?? 0) > 0
    || (result.replace_failures?.length ?? 0) > 0
    || (result.failed_enables?.length ?? 0) > 0;
}
