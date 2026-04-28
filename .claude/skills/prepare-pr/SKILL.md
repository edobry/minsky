---
name: prepare-pr
description: >-
  Prepare and create a pull request: verify completeness, generate description,
  format title, and submit via MCP tools.
  Use when creating a PR, preparing a PR, or submitting changes for review.
user-invocable: true
---

# Prepare PR

Prepare and submit a pull request with a well-structured description following conventional commits format.

## Arguments

Optional: task ID (e.g., `/prepare-pr mt#123`). If omitted, uses the current session's task.

## Process

### 1. Verify implementation completeness

Before creating a PR:

- All task requirements implemented (check spec with `mcp__minsky__tasks_spec_get`)
- All tests pass (pre-commit hooks handle this)
- Code quality acceptable (no linting issues)
- No scope reductions without explicit user approval

**Pacing discipline:** Do not weaken tests or relax assertions to achieve a green state. A non-green state is acceptable while restoring correctness. Never trade fidelity for speed.

### 1a. Live-target check for verify/probe/smoke scripts

Some scripts have a contract that no static check can verify: their assertions must agree with a live external system (production deploy, hosted API, real database). For those, unit tests and type checks are insufficient — only running them against the live target proves they work.

Before continuing, ask: **does this PR modify a verify, probe, smoke, or live-system-check script?** Cues:

- File path or name contains `verify`, `probe`, `smoke`, `health-check`, `e2e`, or similar.
- The script's assertions reference an external system (production URL, hosted API, deployed service).
- The script's value is "catch drift between code and the live system."

In scope: read-only / non-destructive checks (HTTP GET probes, `--phase=verify`–style assertions, status reads). Out of scope: scripts that have side effects on the target (writes, migrations, deletes, load tests). If your script has side effects, this step does NOT apply — those need their own pre-merge protocol (staging run + reviewer sign-off), not a paste-into-PR-body.

If in scope:

1. **Confirm read-only first.** Reading the script, verify it does not mutate the target. If unsure, treat as out-of-scope.
2. **Prefer the highest-fidelity environment you have access to.** Production-parity staging is preferred when it exists; production is acceptable for read-only probes; local mock environments do NOT satisfy this step.
3. **Run the script. Capture the output.**
4. **Redact before pasting.** Output may contain bearer tokens, session IDs (capability tokens — treat like passwords), Authorization headers, internal hostnames/IPs, user data, or other sensitive fields. Before pasting:
   - Replace bearer tokens / API keys with `<REDACTED>` or `Bearer ****`.
   - Replace session IDs and cookies with length-only summaries (`session-id-len=36`).
   - Strip credentials embedded in URLs (a `<scheme>://<user>:<pw>@host/db`-style URL becomes `<scheme>://<REDACTED>@host/db`) and any sensitive query-string parameters (`?token=…`, `?api_key=…`).
   - Strip request/response headers beyond Authorization that may carry sensitive identifiers (`Set-Cookie`, `X-Amzn-Trace-Id`, internal trace headers).
   - Strip raw response bodies that may contain stack traces, config fragments, or PII — paste structural assertions only (`status=200, mcp-session-id present`) rather than full response bodies.
   - When in doubt, paste a clearly-attributed summary instead of raw output.
5. **Paste into the PR body** under a `## Test plan` or `## Live verification` section. The reader should be able to see the script ran, what it asserted, and that no defect was found — without seeing any secrets.

**Override exceptions** (any of the following — document in the PR body which applies):

- The target hasn't been deployed yet (run-after-deploy planned).
- The author lacks access to the live target per access policy (not a personal access gap — a documented policy boundary). In this case: tag a maintainer with the right access to run the script and attach the output as part of review.
- The target has a maintenance window or rate-limit constraint that makes ad-hoc runs harmful. Document the constraint and the alternative validation.
- "I read the code carefully" is NOT a valid override.

**Why:** mt#1194 shipped probe assertions that never matched production because no one ran the script before merging. The defect was discovered ~5 hours post-merge and required a follow-up PR (mt#1267, [PR #791](https://github.com/edobry/minsky/pull/791) — see its body for the live-verify output that should have run pre-merge) to fix. The agent-memory entry `feedback_run_end_to_end_verify_end_to_end` captures the lesson; PR #791 is the in-repo evidence trail for human readers without access to that memory store.

This is a checklist item, not a hard gate. The override exceptions exist for legitimate cases. The failure mode this guards against is "the code looks right but the live system disagrees" — and the cost of a five-hour post-merge discovery is much higher than the cost of one extra `bun scripts/...` invocation per PR.

**Reviewer-side**: when reviewing a PR that touches a verify/probe/smoke script, confirm the PR body either contains the redacted live output OR a documented override exception. If neither is present, request the live-run output before approving.

### 2. Commit all changes

Use `mcp__minsky__session_commit` with:

- `all: true` to stage everything
- A descriptive commit message referencing the task ID

### 3. Write the PR description

Structure the description with these sections:

**Required sections:**

- **Summary** — 2-3 sentence overview. Reference the task ID.
- **Motivation & Context** — Why this change is needed. Reference the task spec.
- **Design/Approach** — High-level approach. Mention alternatives considered.
- **Key Changes** — Bullet points of significant changes, grouped by area.
- **Testing** — How changes were tested. New tests added.

**Conditional sections (include when applicable):**

- **Breaking Changes** — Migration paths, before/after examples
- **Data Migrations** — Format changes, backward compatibility
- **Ancillary Changes** — Changes outside the task scope with justification
- **Screenshots/Examples** — Visual examples for UI changes

### 4. Format the title parameter (description-only)

The `title` parameter you pass to `session_pr_create` is **description-only**. The tool composes the visible PR title from your `title` plus the `type` and task ID.

**Author input rules (what you pass as `title:`):**

- **Do NOT include** conventional commit prefixes — any of `feat:`, `fix:`, `docs:`, `feat(scope):`, etc.
- **Do NOT include** task-ID prefixes — `mt#123:`, `md#409:`, `gh#42:`, `mt-123:`, or the bare `#123:` form. The composer's `TASK_ID_PREFIX_RE` matches all of these.
- Keep it short and descriptive.

**Tool behavior on violation** (in `src/adapters/shared/commands/session/pr-conventional-title.ts`):

- **Conventional prefix** (`feat:`, `fix:` etc.): the helper throws `ValidationError` with message `Title should be description only — the prefix \`${autoPrefix}\` will be added automatically. Pass title without that prefix.` So this surfaces as a tool error, not silent drift.
- **Task-ID prefix when you pass `task:` and the prefix matches** (e.g., `title: "mt#123: foo"` + `task: "mt#123"`): the prefix is silently stripped before composition. Final title becomes `feat(mt#123): foo`.
- **Task-ID prefix when you pass `task:` and the prefix mismatches** (e.g., `title: "md#409: foo"` + `task: "mt#123"`): the helper throws `ValidationError` (`"Title task-ID prefix \`md#409:\` does not match supplied taskId (mt#123)..."`). Project-code mismatch (md vs mt) and digit mismatch are both caught.
- **Task-ID prefix when you do NOT pass `task:`** (e.g., `title: "#123: foo"` with no `task` parameter): the prefix is **preserved verbatim** — the helper can't validate against a missing reference, so it doesn't strip. Visible title becomes `feat: #123: foo`. Avoid this; pass `task:` so the helper can deduplicate.

(`session_pr_create` accepts `task:` in its parameters and passes it through to the composer as `taskId:`. They're the same thing under different names.)

**What the visible PR title looks like (composed by the tool):**

The visible title on GitHub depends on whether `task:` was supplied:

| You pass                                                                     | GitHub displays                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `title: "Add session file read MCP tool"`, `type: "feat"`, `task: "mt#123"`  | `feat(mt#123): Add session file read MCP tool`  |
| `title: "Mask credentials in config.show"`, `type: "fix"`, `task: "mt#1262"` | `fix(mt#1262): Mask credentials in config.show` |
| `title: "Add new feature"`, `type: "feat"` (no `task:`)                      | `feat: Add new feature`                         |

This is intentional and follows conventional commits. If a reviewer flags the visible PR title for "containing a conventional prefix or task ID," they're misreading this rule — the rule applies to author input, not to what GitHub displays. The visible composition is correct and intentional.

### 5. Create the PR

Use `mcp__minsky__session_pr_create` with:

- `title`: description-only title
- `type`: one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- `body`: the PR description (starts with `## Summary`, never duplicates the title)
- `task`: the task ID

The tool automatically:

- Rebases on latest main before creating the PR
- Sets task status to IN-REVIEW
- Pushes the branch

### 6. Stop working on the session branch

After PR creation, do NOT continue committing to the session branch. Switch to main workspace if further work is needed.

## PR types

| Type       | Use for                                |
| ---------- | -------------------------------------- |
| `feat`     | New features                           |
| `fix`      | Bug fixes                              |
| `docs`     | Documentation changes                  |
| `style`    | Formatting, no logic change            |
| `refactor` | Code restructuring, no behavior change |
| `perf`     | Performance improvements               |
| `test`     | Adding or modifying tests              |
| `chore`    | Build process, auxiliary tools         |

## Anti-patterns

- **Committing PR description files** to the repo — use `--body` parameter, never commit `pr.md` files
- **Duplicating title in body** — title goes in `--title` only, body starts with `## Summary`
- **Wrong task content** — verify PR content matches the current task, not a previous one
- **Continuing work after PR creation** — the PR is the final step in the session

## Key principles

- **The PR description is for reviewers.** Explain why, not just what.
- **Description-only titles.** The tooling adds the conventional commit prefix.
- **Body starts with `## Summary`.** Never duplicate the title.
- **One PR per session.** After PR creation, the session is done.
