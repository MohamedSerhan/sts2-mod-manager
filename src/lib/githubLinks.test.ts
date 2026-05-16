import { describe, expect, it } from 'vitest';

import { buildGitHubIssueUrl, GITHUB_TOKEN_TEMPLATE_URL } from './githubLinks';

describe('githubLinks', () => {
  it('builds a prefilled fine-grained token URL', () => {
    const url = new URL(GITHUB_TOKEN_TEMPLATE_URL);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(url.searchParams.get('name')).toBe('STS2 Mod Manager');
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('administration')).toBe('write');
  });

  it('caps GitHub issue URLs so browser requests do not exceed GitHub limits', () => {
    const longBody = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'x'.repeat(120)}`).join('\n');
    const url = buildGitHubIssueUrl('Bug report', longBody);
    const parsed = new URL(url);

    expect(url.length).toBeLessThanOrEqual(3900);
    expect(parsed.searchParams.get('title')).toBe('Bug report');
    expect(parsed.searchParams.get('body')).toContain('Truncated to fit GitHub issue URL limits');
  });
});
