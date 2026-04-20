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
