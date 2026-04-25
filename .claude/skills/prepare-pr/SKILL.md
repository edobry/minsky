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

If yes:

1. Run the script against the live target. Capture the output.
2. Paste the output (or a clearly-attributed summary of it) into the PR body under a `## Test plan` or `## Live verification` section.
3. If running against the live target is genuinely impossible (e.g., the target hasn't been deployed yet), state that explicitly in the PR body and note what manual verification was done in its place.

**Why:** mt#1194 shipped probe assertions that never matched production because no one ran the script before merging. The defect was discovered ~5 hours post-merge and required a follow-up PR (mt#1267) to fix. See `feedback_run_end_to_end_verify_end_to_end` for the underlying lesson.

This is a checklist item, not a hard gate — if you have a substantive reason to skip it, document the reason in the PR body. But "I read the code carefully" is not a substantive reason; the failure mode this guards against is "the code looks right but the live system disagrees."

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

### 4. Format the PR title

The title is **description-only**:

- **Do NOT include** conventional commit prefixes (`feat:`, `fix:`)
- **Do NOT include** task IDs (`(mt#123)`)
- Keep it short and descriptive

Good: `Add session file read MCP tool`
Bad: `feat(mt#123): Add session file read MCP tool`

The `type` parameter on `session_pr_create` handles the conventional commit prefix automatically.

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
