// scripts/qa-pipeline.mjs
// Pure helpers + thin CLI for the QA-review loop + approval-gated auto-merge
// (sub-project C+). Spec: docs/superpowers/specs/2026-05-29-qa-review-approval-merge-design.md
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const QA_ROUND_MARKER = '<!-- qa-round -->';
export const QA_MAX_ROUNDS = 5;
export const MAINTAINER_LOGIN = 'MohamedSerhan';

/** Next QA round number = (PR comments containing the round marker) + 1. */
export function nextQaRound(commentBodies) {
  const seen = (Array.isArray(commentBodies) ? commentBodies : []).filter(
    (b) => typeof b === 'string' && b.includes(QA_ROUND_MARKER),
  ).length;
  return seen + 1;
}

/** Normalize a labels array (strings or {name}) to a string[]. */
function labelNames(labels) {
  return (labels || [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/** Auto-merge predicate. CI-green is NOT a pure input — it's checked at runtime by
 *  the merge workflow; this gates the human+label conditions only. */
export function isMergeEligible({ reviewState, reviewerLogin, labels } = {}) {
  const names = labelNames(labels);
  return (
    reviewState === 'approved' &&
    reviewerLogin === MAINTAINER_LOGIN &&
    names.includes('qa') &&
    names.includes('qa-passed')
  );
}

function readStdin() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'cap') {
    console.log(QA_MAX_ROUNDS);
  } else if (cmd === 'round') {
    // stdin: a JSON array of comment bodies (or of {body} objects).
    let arr = [];
    try { arr = JSON.parse(readStdin() || '[]'); } catch { arr = []; }
    const bodies = Array.isArray(arr)
      ? arr.map((x) => (typeof x === 'string' ? x : x && x.body))
      : [];
    console.log(nextQaRound(bodies));
  } else if (cmd === 'merge-eligible') {
    // Reads the GitHub pull_request_review event JSON at $GITHUB_EVENT_PATH.
    // Exit 0 = eligible, 1 = not.
    const p = process.env.GITHUB_EVENT_PATH;
    let ev = {};
    try { ev = JSON.parse(readFileSync(p, 'utf-8')); } catch { ev = {}; }
    const ok = isMergeEligible({
      reviewState: ev?.review?.state,
      reviewerLogin: ev?.review?.user?.login,
      labels: ev?.pull_request?.labels,
    });
    console.log(ok ? 'eligible' : 'not-eligible');
    process.exit(ok ? 0 : 1);
  } else {
    console.error('usage: qa-pipeline.mjs round|cap|merge-eligible');
    process.exit(2);
  }
}
