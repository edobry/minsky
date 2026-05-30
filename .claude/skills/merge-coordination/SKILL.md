---
name: merge-coordination
description: >-
  Main-agent skill for coordinating the merge of a PR after the canonical
  `minsky-reviewer[bot]` review. Covers: gathering bot review status, running
  the local smoke test, diagnosing reviewer-bot silence, and bypass-merging
  bot-authored PRs.
user-invocable: true
---

# Merge Coordination Skill

Coordinate the merge of a PR after the `minsky-reviewer[bot]` posts its review.

## Arguments

The argument is a task ID (e.g., `/merge-coordination mt#328`) or a GitHub PR URL. The bot reviews automatically; this skill is invoked when you need to check merge status, diagnose silence, or execute the bypass-merge path.

## Process

### 1. Gather context

Use `mcp__minsky__session_pr_review_context` with the task ID or session ID to fetch all review data in a single call. This returns PR metadata, CI check runs, the raw diff, the task spec, and existing review threads with resolved/outdated state.

If the session tool fails (e.g., no session exists for this PR), fall back to fetching in parallel:

- PR metadata: `mcp__github__pull_request_read` with `method: "get"`
- CI status: `mcp__github__pull_request_read` with `method: "get_check_runs"`
- Bot review status: `mcp__github__pull_request_read` with `method: "get_reviews"` — look for a review by `minsky-reviewer[bot]`

The goal of this step is to surface: (a) whether the bot has posted a review, (b) the review state (APPROVED, CHANGES_REQUESTED, COMMENT), (c) whether CI is green, and (d) whether any BLOCKING findings remain open.

### 2. Identify the task

Extract the task ID from the PR title or branch name (e.g., `mt#671` from `task/mt-671`). If the task spec was not already returned by step 1, fetch it with `mcp__minsky__tasks_spec_get`. This is needed for smoke test targeting (step 6.3) and bypass-merge audit trail (step 8).

### 3. Watch for bot review + CI in parallel

**When waiting for the bot's review and CI, kick off both in the same message.** Use a single tool-call message with TWO parallel calls:

1. `mcp__minsky__session_pr_wait-for-review(task: "mt#X", reviewer: "minsky-reviewer[bot]")` — waits for the next bot review
2. `mcp__minsky__session_pr_checks(task: "mt#X", wait: true, timeoutSeconds: 600)` — CI polling waits synchronously

The reviewer waits until a review arrives; CI polling waits synchronously. When both complete, the merge decision can be made in one step instead of two sequential round-trips. This pattern saves 5–10 minutes per merge cycle.

On subsequent waits (after pushing a fix — pass `since` set to the previous review's `submittedAt` timestamp so the call returns the NEW review, not the stale one):

```
mcp__minsky__session_pr_wait-for-review(
  task: "mt#<id>",
  reviewer: "minsky-reviewer[bot]",
  since: "<previous review.submittedAt>"
)
```

Reference: `feedback_parallel_subagent_dispatch_pattern` for the broader parallel-dispatch pattern this is a special case of.

### 6.3 Smoke test

Run at least one CLI command that exercises the changed code path against the PR branch. Examples:

- DI-changing PR → `bun src/cli.ts tasks list` to verify the container initializes correctly
- Session-mutation PR → `bun src/cli.ts session list`
- New CLI command → invoke the new command with a representative argument
- Docs / prompt-only PR → may skip with rationale recorded in the review body

Record one of three outcomes for the review body's `Smoke:` line:

- `pass — <command run>` if the command exited 0
- `fail — <command run>: <stderr summary>` if it exited non-zero (BLOCKING finding)
- `skipped — <rationale>` for docs / prompt-only / config-only PRs where no code path runs (`skipped` is acceptable; the pre-merge hook treats it as a valid value, not as missing)

**Smoke is an independent gate, not part of CI-status counts.** The `CI status` line counts only GitHub Actions check_runs; the Smoke line is a separate field that the pre-merge hook parses independently. A Smoke=`fail` blocks merge regardless of CI N/M; a Smoke=`skipped` is treated as a valid value (not as missing).

The smoke catches PR-introduced regressions that pre-merge CI may have missed (container init failures, command-registration breakage, etc.). It does **not** cover concurrent-merge interactions — those are tracked separately in mt#1592.

### 7a. Reviewer-bot silence on subsequent commits

After pushing a follow-up commit that addresses BLOCKING findings, `minsky-reviewer[bot]` should fire a new review within ~5 minutes. If it doesn't, that's almost certainly the **webhook-miss-on-subsequent-push** reliability class (mt#1110-tracked; instances on mt#677, mt#748, PR #763).

**Diagnosis steps:**

1. Confirm the latest push reached GitHub: `mcp__minsky__session_pr_get` and check `head.sha` matches your local HEAD.
2. Check whether CI fired on the same push: `mcp__minsky__session_pr_checks` (or `mcp__github__pull_request_read` with `method: "get_check_runs"` if the Minsky tool is unavailable). If CI also produced 0 check_runs, that's a separate `webhook/CI-trigger` problem — note both classes when filing a reliability issue. The merge gate enforces this independently as of mt#1309.
3. Wait at most 5 minutes. Do not loop indefinitely.

**Unblock options** (in preference order):

- **Empty commit to wake the webhook**: push an empty commit (`session_commit` with `noFiles: true` and `noStage: true`) and wait again. Often resolves the miss.
- **Bypass merge** via `gh api PUT /repos/.../pulls/N/merge` (`merge_method=merge`, with audit message naming the substantive fixes that landed). Only after BLOCKING findings are addressed and the remaining gap is the missing reviewer signal.
- **Track the instance** in the agent memory store (`mcp__minsky__memory_create`) so the calibration work has data points.

The webhook-miss class is distinct from the same-App-identity APPROVE block above: same-App is a _structural_ gate (when `minsky-ai[bot]` is both author and reviewer, GitHub rejects the APPROVE — see step 8 event selection), webhook-miss is a _reliability_ gate against the cross-identity `minsky-reviewer[bot]` failing to fire. Recognize which one you're hitting before choosing a recovery path.

### 8. Bot-authored PR merge

**This section applies when the PR author is `minsky-ai[bot]` or any bot identity.**

GitHub structurally blocks self-approval: a PR author cannot APPROVE their own PR. When `minsky-ai[bot]` opened the PR and the same App identity is submitting the review, the reviewer can only post `COMMENT` — never `APPROVE`. This is a platform constraint, not a configuration issue.

**Prerequisite checks before merging:**

1. Chinese-wall reviewer (`minsky-reviewer[bot]`) has cleared all blocking findings (review posted to GitHub)
2. CI is green (all required checks passing)
3. No `REQUEST_CHANGES` reviews outstanding that haven't been resolved

**Standard merge path:**

Use `mcp__minsky__session_pr_merge`. This succeeds after reviewer-bot APPROVE or when the review body satisfies the merge-gate's text patterns.

**Bypass merge via `gh api PUT`** (only when `session_pr_merge` fails AND bypass conditions are met):

```
gh api -X PUT /repos/<owner>/<repo>/pulls/<N>/merge \
  -f merge_method=merge \
  -f commit_title="Merge pull request #<N> from <branch>" \
  -f commit_message="<body>"
```

The `merge_method=merge` flag is **required**. Minsky preserves merge commits per `docs/pr-workflow.md`. The `merge_method=squash` value is hook-blocked — using it will fail at the pre-merge hook.

**Bypass conditions** (per `feedback_self_authored_pr_merge_constraints`): R ≥ 1 substantive review rounds have completed AND any one of: (a) reviewer-bot fired CoT-leakage errors twice consecutively on the same HEAD; OR (b) round-N self-reversal — round N's BLOCKING contradicts an earlier round's accepted fix; OR (c) reviewer-bot silent for >5 minutes after diagnosing the silence per §7a above.

**Audit trail requirement:** The commit message must document the bypass:

> "Bot self-approval bypass per feedback_self_authored_pr_merge_constraints — Chinese-wall review cleared, CI green."

This is not optional. Without an audit trail, the bypass is indistinguishable from a merge that skipped review.

References: `feedback_self_authored_pr_merge_constraints`, `feedback_gh_api_bypass`.

## Regression example: 2026-04-28 session (9 PRs merged)

During the 2026-04-28 reviewer structural-output session, 9 PRs were merged in approximately 6 hours using the parallel reviewer+CI poll pattern combined with the `gh api PUT` bypass for bot-authored PRs. Representative merges:

- mt#1388, mt#1390 — merged within 5–7 minutes of "code complete" using parallel dispatch
- mt#1395 cluster — back-to-back merges benefiting from pre-warmed CI poll state
- mt#1404, mt#1413 — both used the `gh api PUT` bypass after Chinese-wall reviewer posted COMMENT (not APPROVE)

Without the parallel pattern (sequential: wait for CI, then wait for reviewer), the same 9 PRs would have required approximately 12 hours at ~5–10 min overhead per PR plus reviewer subagent latency. The parallel pattern halved the wall-clock time.

This pattern is now canonical operating procedure for bot-authored PRs.

## Worked example: bot review + agent watches + merge

The `minsky-reviewer[bot]` fires automatically on every push to a PR branch. The main agent's role is to watch for the review, assess the outcome, and drive to merge.

**Typical flow:**

1. **PR created** by `minsky-ai[bot]` via `session_pr_create`.
2. **Agent calls §3** (parallel watch): `session_pr_wait-for-review` + `session_pr_checks` in the same message. Both block until the bot posts its review and CI completes.
3. **Bot posts APPROVE** with a well-formed review body (spec verification, adoption sweep, smoke test, documentation impact).
4. **Merge gate passes**: all required checks present, Smoke field valid, spec verification table present, documentation impact section present.
5. **Agent calls `session_pr_merge`**. The at-merge handler sets DONE atomically.

**Variation: CHANGES_REQUESTED flow:**

3. **Bot posts CHANGES_REQUESTED** with BLOCKING findings.
4. **Agent fixes findings**, commits, pushes.
5. **Agent calls §3 again** with `since: "<previous review.submittedAt>"` to wait for the new review.
6. **Bot posts APPROVE** on the updated commit.
7. **Agent calls `session_pr_merge`**. DONE.

**Variation: webhook miss:**

3. **Bot doesn't post** within 5 minutes after push.
4. **Agent runs §7a diagnosis**: confirms push reached GitHub, checks CI fired, waits 5 min, tries empty commit to wake webhook.
5. **If still silent**: bypass merge per §8 with audit trail.

## Key principles

- **The bot reviews; the agent coordinates.** `minsky-reviewer[bot]` is the canonical reviewer — do not attempt to perform your own code review. This skill covers orchestration around the bot's review, not content production.
- **Parallel watch saves wall time.** Always dispatch `session_pr_wait-for-review` and `session_pr_checks` in the same tool-call message.
- **Smoke is the agent's local gate.** Run the smoke test yourself per §6.3; it is a local-agent action the bot cannot perform.
- **Diagnose before bypassing.** The webhook-miss diagnosis in §7a is a structured ladder — run it before reaching for the bypass merge.
- **Bot-authored PRs require the bypass path.** Self-approval is structurally blocked by GitHub; never attempt to APPROVE a PR from the same App identity that opened it.
- **The docs/gate gap is structurally prevented.** The merge gate enforces the structured review fields (spec verification, adoption sweep, smoke, documentation impact) via tool-call provenance inspection; the agent's role is to drive the cycle, not to re-implement the checks.
