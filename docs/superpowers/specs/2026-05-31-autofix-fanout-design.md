# Auto-fix Fanout — Design

**Date:** 2026-05-31
**Status:** Approved in brainstorming — pending spec review → implementation plan
**Author:** Claude, brainstormed with @MohamedSerhan

## Summary

Extend the auto-fix bot so that a single `auto-fix` issue too large for one Claude
pass is **decomposed by an orchestrator into independent sub-tasks, implemented by
parallel subagents in one shared workspace, reconciled onto a single branch, and
opened as one PR** — which then flows through the existing QA loop + maintainer
approval + CI Gate **unchanged**. The goal is both capability (finish big multi-file
work a single pass cannot) and speed (parallelism), with no new release risk.

## Background & motivation

Today `claude-autofix.yml`'s `initiate` job runs one `claude-code-action` pass
(`--max-turns 60`). Its prompt already **gauges scope** (STEP 0):

- A **CONTAINED** change is implemented + tested + opened as a PR.
- A **LARGE** change gets a posted implementation **plan** (files to touch, approach,
  a checklist of the independent pieces) and then **STOPS**, handing off to the
  maintainer.

So large features never get implemented autonomously: a single linear context runs
out of turns/context before finishing (the "timeout" the maintainer observed).

Motivating case: issue #55 is *triage* (and it completed). The implementation-sized
work is the feature behind it — a configurable Nexus download folder spanning a
settings field + persistence + UI + the file-watcher + tests. That is exactly the
LARGE shape that stalls today.

**Key insight:** the LARGE branch already produces the decomposition fanout needs
(the checklist of independent pieces). **Fanout = execute that plan instead of
stopping.** This is a surgical change to one job, not a new pipeline.

## Decisions (from brainstorming)

- **Goal:** decompose big features **and** run the pieces in parallel (fan-out /
  fan-in). NOT sequential "auto-resume".
- **Trigger:** **auto-detect** from the existing `auto-fix` label — the orchestrator
  decides single-pass vs fan-out per issue. No new label, no plan-approval gate.
  Control stays at the existing merge gate.
- **Output:** **one integrated PR** through the existing `qa` → approval → CI Gate →
  merge flow.
- **Engine:** **Approach B** — one `claude-code-action` job; orchestrator + parallel
  `Task` subagents in a shared workspace; orchestrator reconciles + opens the PR.
  (A multi-machine Actions matrix is a documented future escalation, not v1.)

## Non-goals (v1)

- Sequential "auto-resume until done" (a different model; rejected).
- Multi-machine / Actions-matrix parallelism (escalation path only).
- Multiple or stacked PRs per issue.
- Any change to the CONTAINED single-pass path.
- Any change to the QA loop, approval-merge, or CI Gate workflows.

## Architecture — orchestration flow

Only the `initiate` job changes.

1. **Gauge scope** — unchanged STEP 0.
2. **Contained →** single pass, byte-identical to today.
3. **Large → fan out** (replaces today's "post plan + STOP"):
   1. Decompose into **≤ N independent pieces with disjoint file scopes** — the
      checklist it already writes today.
   2. Post the plan (issue comment; later the PR body) for maintainer visibility.
   3. **Spawn parallel subagents, one per piece** (`Task` tool). Each gets its own
      fresh context + turn budget and edits only its assigned files + tests.
   4. **Integration pass (orchestrator):** edit the shared/glue files to wire the
      pieces together; run the full suite; iterate to green.
   5. Open **one PR** on branch `auto-fix/<issue>`.
4. **Downstream unchanged** — label step (`dev-build + auto-fix + qa`) → QA loop →
   maintainer approval → CI Gate → merge.

Capability comes from each subagent having its own context + turn budget (the
orchestrator's `--max-turns 60` no longer bounds the whole job's implementation
work). Speed comes from running the subagents in parallel.

## Decomposition, isolation & reconciliation

- **Isolation by file scope:** each piece exclusively owns a **disjoint** set of
  files (ideally its own new modules + tests). Two subagents never edit the same
  file, so parallel writes cannot collide.
- **Glue is the orchestrator's:** shared files (a router, a types file, an
  index/registry, settings wiring) are given to **no** subagent; the orchestrator
  edits them in the integration pass. Pieces are the leaves, glue is the trunk.
- **Not forced to over-split:** if a feature won't partition cleanly, the
  orchestrator uses judgment — fewer pieces, or sequence the ones that must share a
  file.
- **Subagent brief:** one piece + its file scope + "implement & test your slice,
  touch nothing outside it, report what you changed." Fresh context, own budget.
- **Reconciliation:** orchestrator wires the glue → runs `npm test` (frontend +
  Rust) → fixes integration breakage → commits → opens the PR. The PR arrives
  already self-tested, so it enters the QA + CI gate in good shape.

## Bounds, failure handling & safety

**Bounds (the cost lever, since auto-detect has no pre-gate):**

- Hard cap **N pieces** (default **5**, a tunable knob). Beyond N: take the top-N
  most independent pieces and list the rest as "remaining work" rather than spawning
  an unbounded swarm.
- One job / one runner. Cost = orchestrator turns + ≤ N subagent budgets. The
  orchestrator's `--max-turns` is bumped; each subagent carries its own budget.

**Failure handling (never silently partial — the existing rule, extended):**

- A subagent fails / returns incomplete → orchestrator retries it once, or finishes
  that piece itself.
- A piece is genuinely blocked → orchestrator still opens the PR with the completed
  pieces + a checklist of what's left + the blocker noted.
- Too tangled to split safely → fall back to today's behavior (post the plan as an
  issue comment and stop).
- Orchestrator itself errors before any PR → the existing "🤖 couldn't complete
  this" error-report step already catches it.

**Safety / no release to users:**

- Downstream is byte-identical to today: one PR → `qa` → QA loop → **maintainer
  approval** → CI Gate → merge to `main`. No tags, no `publish-*`, no updater. A
  fanout PR cannot ship to users.
- The QA + approval gate is the backstop for auto-detect: a misjudged fan-out wastes
  tokens but physically cannot merge or ship. Worst case is a wasted run, never a
  broken app.

## Reuse vs change

**Unchanged:** `claude-autofix-qa.yml` (QA loop), `claude-autofix-merge.yml`
(approval-merge), `ci.yml` (CI Gate), the `revise` job, the label step, the
error-report step. None of them know or care that a PR came from a fanout — it is
just a PR on `auto-fix/<issue>`.

**Changed (all inside the `initiate` job):**

- Rewrite the LARGE branch of the prompt: "post plan + stop" → "decompose → spawn
  subagents → integrate → open one PR".
- `allowedTools`: add `Task`.
- Orchestrator `--max-turns`: bumped.
- One small config knob for **N** (the piece cap).

The CONTAINED path stays byte-identical, so small issues carry zero new risk.

## Validation

1. **Spike the load-bearing assumption first** — a throwaway run that confirms
   `claude-code-action` actually runs parallel `Task` subagents over the shared
   workspace. Cheap insurance before writing the full orchestrator prompt; settles
   parallel-vs-sequential up front.
2. **Real end-to-end** — label a genuinely big issue `auto-fix` (candidate: the
   configurable Nexus download-folder feature behind #55) → watch it fan out → one
   integrated PR → `qa` → QA loop → maintainer approval → CI Gate.

**Done =** the PR visibly integrates multiple pieces; the full suite is green; it
reads as one coherent feature; QA passes; the maintainer approves; CI Gate is green;
it merges — and the latest release is unchanged (no user release).

## Risks & open questions

- **Load-bearing assumption:** parallel `Task` subagents in `claude-code-action` over
  a shared workspace. *Mitigation:* spike first; graceful degradation to **sequential
  subagents** (keeps capability + fresh contexts, loses only the wall-clock speedup);
  ultimate escalation is the Actions matrix.
- **Clean partitioning isn't always possible.** *Mitigation:* orchestrator owns the
  glue + uses judgment; worst case downgrades to today's plan-and-stop.
- **N default (5) is a guess.** Tune after real runs.

## Future escalation (out of scope for v1)

If the single-job ceiling is hit on truly enormous issues, escalate to a multi-job
Actions matrix: each sub-task its own `claude-code-action` job + branch, with a
fan-in job that reconciles onto the feature branch and opens the PR. Much of B's
logic (decompose, reconcile, open-one-PR) is reusable, so B is a safe first step.
