import { describe, it, expect, vi } from 'vitest';
import { isDevBuild } from './isDevBuild';
import { setMockAppVersion } from '../__test__/setup';

describe('isDevBuild', () => {
  it('is true for a -dev version', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    expect(await isDevBuild()).toBe(true);
  });

  it('is false for a release version', async () => {
    setMockAppVersion('1.6.1');
    expect(await isDevBuild()).toBe(false);
  });

  it('is false when getVersion rejects', async () => {
    const app = await import('@tauri-apps/api/app');
    (app.getVersion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no runtime'));
    expect(await isDevBuild()).toBe(false);
  });
});
