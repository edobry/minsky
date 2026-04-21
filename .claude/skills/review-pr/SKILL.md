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

Use `mcp__minsky__session_pr_review_context` with the task ID or session ID to fetch all review data in a single call. This returns PR metadata, CI check runs, the diff, and the task spec.

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

**Coverage gate:** Before proceeding to step 7 (Post to GitHub), you MUST have read or had agents read 100% of the diff. State explicitly: "Coverage: X/Y files reviewed." If coverage is not 100%, do NOT post. Sampling is not reviewing — it is performing diligence theater.

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

### 5a. Behavioral residue search (removal PRs only)

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

**Primary path:** Use `mcp__minsky__session_review_submit` when the PR is linked to a Minsky session. Extract the task ID from the branch name (e.g., `task/mt-847` → `mt#847`) and call:

```
mcp__minsky__session_review_submit
  task: "mt#847"   (or sessionId if known)
  body: "<full review body>"
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"
  comments: [{ path, line, body, side? }]   (optional, for line-level comments)
```

This posts the review under the configured bot/service-account identity.

**Fallback:** If `mcp__minsky__session_review_submit` is unavailable or the PR is not linked to a Minsky session, use `mcp__github__pull_request_review_write` directly:

- `method: "create"` with `event` to submit immediately
- For line-level comments: create a pending review first, add comments with `add_comment_to_pending_review`, then `submit_pending`

**Event selection (applies to both paths):**

- Use `event: "APPROVE"` only if you are not the PR author and there are no blocking issues
- Use `event: "COMMENT"` if you are the PR author or there are only non-blocking issues
- Use `event: "REQUEST_CHANGES"` if there are blocking issues or unmet spec criteria

### 8. Review body format

```markdown
## Review: <short description>

**CI status:** <pass/fail/pending>

### Findings

<For each verified finding:>
**[BLOCKING/NON-BLOCKING/PRE-EXISTING]** <file:line> — <description>
<evidence from source code that confirms this is real>

### Checked and clear

<Brief list of areas reviewed with no issues — shows coverage>

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

## Key principles

- **A review that isn't on GitHub isn't a review.** Always post via GitHub MCP tools.
- **Never flag unverified concerns.** Every finding must be confirmed by reading the actual source, not just the diff.
- **The diff shows what changed; the codebase shows whether the change is correct.** Always check both.
- **Include CI status.** Don't approve with failing checks.
- **Spec verification is mandatory.** The review must include a spec verification table. The pre-merge hook will reject merges without it.
- **Documentation impact is mandatory.** The review must include a documentation impact section. The pre-merge hook will reject merges without it. If docs need updating but aren't updated in the PR, that's a blocking finding.
- **Attribute AI involvement** per user preferences.
