---
name: review-pr
description: >-
  Review a pull request with codebase-verified findings and spec verification,
  posted as an actual GitHub PR review.
  Use when asked to review a PR, or when a PR is ready for review after subagent work.
user-invocable: true
---

# PR Review Skill

Review a pull request thoroughly and post the review to GitHub.

## Arguments

The argument is a PR number (e.g., `/review-pr 328`) or a GitHub PR URL.

## Process

### 1. Gather context

Use `mcp__minsky__session_pr_review_context` with the task ID or session ID to fetch all review data in a single call. This returns PR metadata, CI check runs, the raw diff, the structured `parsedDiff` (with hunks for line-anchored comment selection), the task spec, and existing review threads with resolved/outdated state.

If the session tool fails (e.g., no session exists for this PR), fall back to fetching in parallel:

- PR metadata: `mcp__github__pull_request_read` with `method: "get"`
- CI status: `mcp__github__pull_request_read` with `method: "get_check_runs"`
- Changed files list: `mcp__github__pull_request_read` with `method: "get_files"`

### 2. Identify the task

Extract the task ID from the PR title or branch name (e.g., `mt#671` from `task/mt-671`). If the task spec was not already returned by step 1, fetch it with `mcp__minsky__tasks_spec_get`. This is needed for step 6.

### 3. Read the diff

If the diff was not already returned by step 1, use `mcp__github__pull_request_read` with `method: "get_diff"`. For large diffs, the result will be saved to a file — read it in sequential chunks until 100% is covered.

**Proportionality rule:** For PRs with > 20 changed files, you MUST dispatch multiple `reviewer` agents (`.claude/agents/reviewer.md`) in parallel, each covering a distinct portion of the diff (~25 files per agent). Use `subagent_type: "reviewer"` when dispatching. A single read pass or a spot-check of selected files is NEVER acceptable for large PRs. The number of reviewer agents should scale with the diff size:

- 1–20 files: Read the diff yourself (single pass is acceptable)
- 21–50 files: Dispatch 2 reviewer agents
- 51–100 files: Dispatch 4 reviewer agents
- 100+ files: Dispatch 5+ reviewer agents

Each reviewer agent receives: the diff file path + line range, the PR's purpose/context, and any specific concerns to watch for. Collect all agent findings before proceeding.

**Mode 1 subagents emit raw observations, not committed `comments[]`.** Section subagents lack `parsedDiff` (which is whole-PR), the task spec, and global review judgment, so they cannot validate anchors safely. As the parent aggregator, you hold the canonical `parsedDiff` from `session_pr_review_context` — validate each subagent's `(path, line, side)` anchor against it (step 5 + the anchor-validation block below), dedupe across slices, assign final severity, demote failed anchors to body entries, and construct the final `comments[]` yourself before posting in step 7. mt#1485 tracks the architectural reshape that formalizes this Mode 1 / parent-as-judge split.

**Coverage gate:** Before proceeding to step 7 (Post to GitHub), you MUST have read or had agents read 100% of the diff. State explicitly: "Coverage: X/Y files reviewed." If coverage is not 100%, do NOT post. Sampling is not reviewing — it is performing diligence theater.

### 3a. Parallel-dispatch reviewer subagent + CI poll

**When dispatching a Chinese-wall reviewer subagent, kick off the CI poll in the same message.** Use a single tool-call message with TWO parallel calls:

1. `Agent(subagent_type: "reviewer", model: "sonnet", run_in_background: true, prompt: ...)` — the reviewer subagent runs in the background
2. `mcp__minsky__session_pr_checks(task: "mt#X", wait: true, timeoutSeconds: 600)` — CI polling waits synchronously

The reviewer runs in the background while CI polling waits synchronously. When both complete, the merge decision can be made in one step instead of two sequential round-trips. This pattern saves 5–10 minutes per merge cycle by eliminating the sequential "wait for CI, then wait for reviewer" sequence.

Reference: `feedback_parallel_subagent_dispatch_pattern` for the broader parallel-dispatch pattern this is a special case of.

### 4. Analyze changes

For each file changed, understand:

- What was removed and what replaced it
- Whether the change is purely mechanical or behavioral

### 5. Verify concerns against the codebase

**This is the critical step.** When you identify a potential issue in the diff:

- **DO NOT report it based on the diff alone.** Read the actual source files in the repo to verify.
- If a function call looks unsafe, read the function's implementation to check for internal guards.
- If a type/field name looks wrong, read the schema/interface definition to confirm.
- If behavior looks changed, read the surrounding code to understand the full context.
- Classify each finding with evidence:
  - **Blocking** — verified real issue introduced by this PR, with file:line evidence
  - **Non-blocking** — real concern but low risk or stylistic, AND genuinely out of scope or requiring separate investigation
  - **Pre-existing** — real issue but not introduced by this PR (note for follow-up)
  - **False positive** — concern was disproven by reading the source (do not include in review)

**Decision gate for non-blocking findings:** If a finding is (a) in-scope for the current task AND (b) the fix is known and actionable, it is **BLOCKING**, not non-blocking. "Non-blocking" means the issue is genuinely out of scope, requires separate investigation, or is a stylistic preference — not "I know the fix but want to defer it." In-scope actionable work must be fixed before merge.

Only include verified findings in the GitHub review. Drop false positives entirely rather than padding the review.

### 5a. Live-target verification check (verify/probe/smoke scripts)

**Required when the PR modifies any verify, probe, smoke, or live-system-check script.** The author should have run the script against the live target and pasted redacted output into the PR body — see `.claude/skills/prepare-pr/SKILL.md` step 1a for what's required of authors.

Cues that this step applies:

- Diff touches files matching `verify`, `probe`, `smoke`, `health-check`, `e2e` patterns.
- The script's assertions reference an external system (production URL, hosted API, deployed service).
- The script's value is "catch drift between code and the live system."

If applicable, confirm the PR body contains one of:

1. **Redacted live-run output** under a `## Test plan` or `## Live verification` section. The output should show structural assertions matched (status codes, well-known field presence) without raw secrets, raw response bodies, or unredacted URLs.
2. **A documented override exception** explaining why a live run wasn't possible: target not yet deployed, author lacks access per policy (with maintainer tagged for run-on-behalf), or maintenance-window/rate-limit constraint with alternative validation noted.

If neither is present, this is a **blocking finding**: request the live-run output (or a documented override) before approving. Mention `mt#1267` / mt#1194 lineage so the author understands why this is enforced — the failure mode is "the code looks right but the live system disagrees," and only running the script catches that.

This check exists because mt#1194 shipped probe assertions that never matched production; the defect was found ~5 hours post-merge. The reviewer-side check ensures author compliance with `prepare-pr` step 1a.

### 5b. Behavioral residue search (removal PRs only)

**Required when `deletions >> additions` or the PR removes a feature/module/backend.** Symbol-level grep catches dangling imports but misses semantic dead code — code that serves removed functionality without importing removed modules.

Search the **entire codebase** (not just changed files) for:

1. **Hardcoded paths/filenames** associated with removed features
2. **Concept-name strings** in comments, descriptions, error messages (beyond import statements)
3. **Interface fields** that only make sense with the removed feature
4. **Inline code blocks** in shared services that manipulate data in the removed format
5. **Utility functions** in shared modules where some exports served the removed feature
6. **Documentation** describing removed behavior

Any hits are **blocking findings** — they indicate incomplete removal.

### 6. Verify against task spec

**This step is mandatory.** If a task spec exists:

1. Read every success criterion in the spec
2. For each criterion, verify the PR actually delivers it by checking the code
3. Classify each criterion:
   - **Met** — the code change satisfies it, with evidence
   - **Not met** — the PR does not deliver this criterion
   - **Not applicable** — criterion was stale or already satisfied before this PR
4. If any criteria are **not met**, this must be flagged as blocking. Before the PR can merge:
   - The task spec must be updated to reflect actual scope
   - Follow-up tasks must be created for deferred items
   - The review must explicitly list what was deferred and why

### 6a. Assess documentation impact

**This step is mandatory.** The pre-merge hook will reject merges without a "Documentation impact" section in the review.

Assess whether the PR's changes affect any project documentation. Consider:

- **Architectural changes** (new pattern, changed lifecycle, new subsystem, changed command registry) → check `docs/architecture.md`
- **Theoretical/structural changes** (new enforcement mechanism, changed VSM organ status, new environmental constraint) → check `docs/theory-of-operation.md`
- **Developer workflow changes** (new test pattern, changed hooks, changed DI approach, new commands) → check `CONTRIBUTING.md`
- **User-facing changes** (new capabilities, changed CLI interface, changed configuration) → check `README.md`

Classify the impact:

- **"No update needed — [reason]"** — the change doesn't affect documented behavior (bugfix, internal refactor, cosmetic)
- **"Updated [doc] in this PR"** — the PR includes documentation updates alongside the code changes
- **"BLOCKING — [doc] needs updating but isn't updated in this PR"** — the change affects documented architecture/behavior and the docs weren't updated. This is a **blocking finding** that should trigger `REQUEST_CHANGES`. The PR cannot merge until the docs are updated in the same PR.

"Follow-up task" is only acceptable when the reviewer provides explicit justification for why the doc update cannot be done in this PR (e.g., requires information from a different workstream that hasn't landed yet).

### 7. Post to GitHub

Use `mcp__minsky__session_pr_review_submit`. Extract the task ID from the branch name (e.g., `task/mt-847` → `mt#847`) and call:

```
mcp__minsky__session_pr_review_submit
  task: "mt#847"   (or sessionId if known)
  body: "<review body — summary, spec table, CI status, cross-cutting concerns>"
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"
  comments: [{ path, line, body, side?, startLine?, startSide? }]
```

This posts the review under the configured bot/service-account identity.

The GitHub MCP server's `mcp__github__pull_request_review_write` tool is banned by a PreToolUse hook (see mt#1030) because it bypasses TokenProvider and produces identity drift. If the Minsky tool fails, file a bug — don't work around it.

**Location-bearing findings MUST be `comments[]` entries.** Do not put inline findings (those with a specific file:line) only in the review body. The body is reserved for: executive summary, spec-verification table, CI status, cross-cutting concerns that do not anchor to a single location, and findings that failed anchor validation.

**Anchor validation before submitting:** GitHub rejects the **entire review** (422) if any comment targets a line not present in the PR diff. Before building a `comments[]` entry:

1. Find the matching `DiffFile` in `parsedDiff` (skip `warning`-flagged files). Lookup depends on side and rename status:
   - **RIGHT-side anchor:** match `file.path === path` (the current filename).
   - **LEFT-side anchor on a rename** (`DiffFile.oldPath` set, `oldPath !== path`): match `file.oldPath === path` only. Do NOT match `file.path === path` — that's the post-rename name.
   - **LEFT-side anchor on a non-rename** (`DiffFile.oldPath` undefined): match `file.path === path` only.
2. Verify the file's `status` permits the chosen side:
   - `status: "added"` — only RIGHT anchors valid (no pre-image to anchor to).
   - `status: "deleted"` — only LEFT anchors valid (no post-image to anchor to). Use `DiffFile.path` (deletions are not renames).
   - `status: "modified"` or `"renamed"` — both sides valid.
3. Iterate `file.hunks[].lines[]` to confirm a `DiffLine` exists at the target line number (`newLine` for RIGHT, `oldLine` for LEFT).
4. **For multi-line ranges** (`startLine` is set): also confirm `startLine` exists on the same side AND both endpoints fall within the same `DiffHunk`; verify `startSide === side`. **This applies equally when the parent aggregator constructs `comments[]` from Mode 1 subagent observations** — provisional anchors that span hunks must be demoted to body, not posted.
5. If any check fails, move the finding to the body under an "Unanchored findings" section.

**Side-mapping rule:**

| DiffLine.side | GitHub `side` value                            | Line number to use                    |
| ------------- | ---------------------------------------------- | ------------------------------------- |
| `RIGHT`       | `"RIGHT"`                                      | `newLine`                             |
| `LEFT`        | `"LEFT"`                                       | `oldLine`                             |
| `CONTEXT`     | `"RIGHT"` or `"LEFT"` (must choose explicitly) | `newLine` (RIGHT) or `oldLine` (LEFT) |

CONTEXT is not a valid GitHub side value. Choose LEFT or RIGHT for context-line anchors.

**Multi-line comments** (e.g., a block spanning lines 88–95): set `startLine` to the first line and `line` to the last. `startSide` must equal `side` — GitHub 422s mismatched sides.

Each comment body must carry a severity prefix: `[BLOCKING] ...` or `[NON-BLOCKING] ...`.

**Event selection:**

- Use `event: "APPROVE"` only if you are not the PR author and there are no blocking issues. GitHub blocks self-approval at the platform level; when `minsky-ai[bot]` opened the PR and is also submitting the review, APPROVE will fail. The human approves Tier-3 PRs (see mt#1065 for the review-time token-routing fix that will make this automatic).
- Use `event: "COMMENT"` if you are the PR author, if the review is from the same identity that opened the PR, or if there are only non-blocking issues.
- Use `event: "REQUEST_CHANGES"` if there are blocking issues or unmet spec criteria.

### 8. Bot-authored PR merge

**This section applies when the PR author is `minsky-ai[bot]` or any bot identity.**

GitHub structurally blocks self-approval: a PR author cannot APPROVE their own PR. When `minsky-ai[bot]` opened the PR and the same App identity is submitting the review, the reviewer can only post `COMMENT` — never `APPROVE`. This is a platform constraint, not a configuration issue.

**Prerequisite checks before merging:**

1. Chinese-wall reviewer subagent has cleared all blocking findings (review posted to GitHub)
2. CI is green (all required checks passing)
3. No `REQUEST_CHANGES` reviews outstanding that haven't been resolved

**Merge command (use `gh api PUT` bypass):**

```
gh api -X PUT /repos/<owner>/<repo>/pulls/<N>/merge \
  -f merge_method=merge \
  -f commit_title="Merge pull request #<N> from <branch>" \
  -f commit_message="<body>"
```

The `merge_method=merge` flag is **required**. Minsky preserves merge commits per `docs/pr-workflow.md`. The `merge_method=squash` value is hook-blocked — using it will fail at the pre-merge hook.

**Audit trail requirement:** The commit message must document the bypass:

> "Bot self-approval bypass per feedback_self_authored_pr_merge_constraints — Chinese-wall review cleared, CI green."

This is not optional. Without an audit trail, the bypass is indistinguishable from a merge that skipped review.

References: `feedback_self_authored_pr_merge_constraints`, `feedback_gh_api_bypass`.

### 9. Review body format

The body is for summary and metadata — NOT for inline findings. All location-bearing findings go in `comments[]`.

```markdown
## Review: <short description>

**CI status:** <pass/fail/pending — N checks passed, M failed>

### Summary

<2–4 sentences: overall assessment, count of BLOCKING / NON-BLOCKING findings posted as inline comments, high-level risk>

### Cross-cutting concerns

<Findings that do NOT anchor to a single location — e.g., "8 of 12 new public functions lack JSDoc". Omit section if none.>

### Unanchored findings

<Findings that failed anchor validation against parsedDiff. Format: **[BLOCKING/NON-BLOCKING]** `file:line` — description. Omit section if none.>

### Spec verification

**Task:** <task ID>

| Criterion             | Status          | Evidence                   |
| --------------------- | --------------- | -------------------------- |
| <criterion from spec> | Met/Not met/N/A | <file:line or explanation> |

<If any criteria not met:>
**Action required:** <spec update needed / follow-up task needed / blocking>

### Documentation impact

<One of:>
No update needed — <reason: bugfix, internal refactor, cosmetic, etc.>

<or:>
Updated <doc> in this PR.

<or:>
**BLOCKING** — <doc> needs updating: <what changed and what section is affected>

(Had Claude look into this — AI-assisted review)
```

## Regression example: 2026-04-28 session (9 PRs merged)

During the 2026-04-28 reviewer structural-output session, 9 PRs were merged in approximately 6 hours using the parallel reviewer+CI poll pattern combined with the `gh api PUT` bypass for bot-authored PRs. Representative merges:

- mt#1388, mt#1390 — merged within 5–7 minutes of "code complete" using parallel dispatch
- mt#1395 cluster — back-to-back merges benefiting from pre-warmed CI poll state
- mt#1404, mt#1413 — both used the `gh api PUT` bypass after Chinese-wall reviewer posted COMMENT (not APPROVE)

Without the parallel pattern (sequential: wait for CI, then wait for reviewer), the same 9 PRs would have required approximately 12 hours at ~5–10 min overhead per PR plus reviewer subagent latency. The parallel pattern halved the wall-clock time.

This pattern is now canonical operating procedure for bot-authored PRs.

## Key principles

- **A review that isn't on GitHub isn't a review.** Always post via GitHub MCP tools.
- **Never flag unverified concerns.** Every finding must be confirmed by reading the actual source, not just the diff.
- **The diff shows what changed; the codebase shows whether the change is correct.** Always check both.
- **Location-bearing findings go in `comments[]`, not the body.** The inline comment UI is the primary surface reviewers read. The body is for summary, spec table, CI status, and cross-cutting concerns.
- **Validate anchors against parsedDiff before submitting.** A single invalid anchor 422s the entire review.
- **Include CI status.** Don't approve with failing checks.
- **Spec verification is mandatory.** The review must include a spec verification table. The pre-merge hook will reject merges without it.
- **Documentation impact is mandatory.** The review must include a documentation impact section. The pre-merge hook will reject merges without it. If docs need updating but aren't updated in the PR, that's a blocking finding.
- **Attribute AI involvement** per user preferences.
- **Parallel reviewer + CI poll saves 5–10 min per merge.** Always dispatch both in the same tool-call message.
- **Bot-authored PRs require the `gh api PUT` bypass.** Self-approval is structurally blocked by GitHub; never attempt to APPROVE a PR from the same App identity that opened it.
