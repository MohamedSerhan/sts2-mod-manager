export const GITHUB_TOKEN_TEMPLATE_URL = (() => {
  const params = new URLSearchParams({
    name: 'STS2 Mod Manager',
    description: 'Browse STS2 mods and publish sts2mm-profiles modpacks',
    expires_in: '90',
    contents: 'write',
    administration: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
})();

const ISSUE_URL = 'https://github.com/MohamedSerhan/sts2-mod-manager/issues/new';
const MAX_ISSUE_URL_LENGTH = 3900;
const TRUNCATED_NOTE =
  '\n\n[Truncated to fit GitHub issue URL limits. Use Copy or the diagnostic bundle for the full logs.]';

export function buildGitHubIssueUrl(title: string, body: string): string {
  const build = (issueBody: string) => {
    const url = new URL(ISSUE_URL);
    url.searchParams.set('title', title);
    url.searchParams.set('body', issueBody);
    return url.toString();
  };

  const full = build(body);
  if (full.length <= MAX_ISSUE_URL_LENGTH) {
    return full;
  }

  let best = build(TRUNCATED_NOTE.trim());
  let lo = 0;
  let hi = body.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidateBody = `${body.slice(0, mid).trimEnd()}${TRUNCATED_NOTE}`;
    const candidate = build(candidateBody);
    if (candidate.length <= MAX_ISSUE_URL_LENGTH) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
