// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { saveNavigationLayout } from './navigationLayout';

describe('navigation layout preferences without a browser window', () => {
  it('skips the change event when window is unavailable', () => {
    expect(() => saveNavigationLayout('sidebar', undefined)).not.toThrow();
  });
});
