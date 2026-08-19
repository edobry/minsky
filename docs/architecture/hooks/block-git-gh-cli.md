# block-git-gh-cli

**Event:** PreToolUse · **Tools:** `Bash`, `mcp__minsky__session_exec` · **Decision:** deny
**Source:** `.minsky/hooks/block-git-gh-cli.ts` · **Tests:** `.minsky/hooks/block-git-gh-cli.test.ts`

Denies `git` and `gh` CLI invocations that have a Minsky MCP equivalent, naming the replacement
in the denial message. Origin: mt#1019 (Bash), extended to `session_exec` by mt#1196.

## Why it exists

MCP tools enforce invariants the raw CLI bypasses — rebase-before-push, session state tracking,
task-linked commits, the PR-freeze invariant. `session_commit` is not a convenience wrapper
around `git commit`; it is the only path that keeps session provenance intact. See mem#263.

There is no `MINSKY_SKIP_*` / `MINSKY_ACK_*` override. Denials are absolute; when the hook blocks
something it should not, the fix is to correct the denial table, not to route around it.

## What it denies

A rule table per binary (`gitDenials`, `ghDenials`), matched against the parsed argument list.
Covers `git add` / `commit` / `push` / `status` / `diff` / `fetch` / `pull` / `clone` / `checkout`,
`git -C` (unconditionally — see below), and the `gh` surfaces with MCP equivalents.

Rules flagged `allowedInSessionExec` are skipped when the call arrives via `session_exec`, because
their denial reason OFFERS `session_exec` as a fallback — denying it there would take away the very
path the message just handed the caller. Four rules are carved out this way: `git status`,
`git stash`, `git reset`, `git restore`.

**What those four messages say, and why it changed (mt#4226).** Until 2026-08-18 they read "for
sessions, use `session_exec`", which framed the choice as a WORKSPACE boundary — MCP tool for main,
CLI for sessions. That boundary stopped existing once `git_status`, `git_reset`, `git_stash` and
`git_restore` all took a `session` parameter, and nothing re-read the guard when they did. Each
message now names its MCP tool WITH that argument first and offers `session_exec` as the fallback
for what the tool does not cover. Only one of the four has a real capability gap to point at:
`git_restore` has no `source` parameter, so `git restore --source=<ref> -- <path>` still needs
`session_exec` (tracked as mt#1297) — and that spelling specifically, because the equivalent
`git checkout <ref> -- <path>` is caught by the `checkout` rule, which has no carve-out.

The durable lesson, since this will age again: a denial string is an instruction carrying hook
authority, and it ages independently of the tool surface it names. When you ship an MCP tool
covering a carved-out command, update the matching `reason` in the same PR (mem#1078).

`git -C` is denied on both tools for different reasons: on Bash it redirects to `session_exec`
(which sets cwd itself); on `session_exec` it is both redundant and dangerous, since `-C` could
point git outside the session root.

## Carve-outs

### Conflict-resolution `git add` (mt#1806)

`git add <paths>` is permitted when every explicitly-named path is in git's unmerged set
(`git diff --name-only --diff-filter=U`). Flags (`-A`, `-u`, `-p`) and `.` count as broad-staging
intent and are never carved out. Fail-closed: if the unmerged set cannot be read, the add is
denied. An audit line goes to stderr on every carve-out.

### Foreign repositories (mt#3788)

On the `Bash` tool only, the guard classifies the repository the command is standing in via
`classifyRepoScope(input.cwd)`:

| Scope           | Meaning                                            | Decision              |
| --------------- | -------------------------------------------------- | --------------------- |
| `project`       | the checkout the hook installation itself lives in | enforce               |
| `session`       | a Minsky session-workspace clone                   | enforce               |
| `external`      | any other git repository                           | allow                 |
| `indeterminate` | no repo root could be established                  | enforce (fail-closed) |

The rationale is that every denial message redirects to a Minsky operation against a
Minsky-managed repo. In a repository Minsky does not manage there is nothing to redirect to, so
the denial blocks work while protecting nothing.

The carve-out is applied **per parsed command**, and only to invocations whose target repository
actually IS the cwd — `isCwdScopedInvocation`. Four details are load-bearing:

- **`gh` is never carved out.** `gh api PUT /repos/edobry/minsky/pulls/N/merge` names its target
  repository in the URL and behaves identically from any directory. Scoping `gh` by cwd would let
  every gh-policy denial — including the merge surfaces — be bypassed by first `cd`-ing to a
  scratch repo. (Caught in PR #2685 R1: the first implementation exited early over the whole
  invocation, which had exactly this effect.)
- **Path-redirecting git flags are never carved out.** `git -C <path>`, `--git-dir`, and
  `--work-tree` point git at a repository other than the one the shell stands in, so cwd answers
  the wrong question. `git -C` is separately denied unconditionally by design.
- **Session workspaces are detected by path, not by root equality.** A session workspace is a
  CLONE, so its repo root never equals the hook installation's root. Without `isMinskySessionPath`
  every session would classify as `external` and the guard would stop enforcing exactly where
  session provenance matters most.
- **`session_exec` is never scoped out.** Its cwd is a session workspace by construction, and the
  `input.cwd` the hook receives for that tool is the harness shell's directory, not the session's
  — so the classification would be answering the wrong question.
- **A command that could relocate the cwd vetoes the carve-out, UNLESS the destination is
  literally readable.** Two functions split this:

  - `commandMayRelocateCwd` is the veto. The scope is resolved once, from the cwd reported at
    invocation, which only describes where a git command runs if nothing moves first. The bypass is
    in the permissive direction: with `input.cwd` in a scratch repo, `cd <project> && git push`
    would otherwise be carved out on a scope computed for a directory the push never happens in
    (PR #2685 R2). It covers `cd` / `pushd` / `popd` / `chdir`, `env -C`, a nested `sh -c`, and any
    subshell or command substitution.
  - `resolveLeadingCdTarget` is the narrow exemption (mt#3798). Vetoing on relocation ALONE made
    the carve-out unreachable in practice: in the Bash tool `cd` is the only way to reach a foreign
    directory at all, so every invocation the carve-out existed for necessarily contained the
    construct that disabled it — mt#3788's Acceptance Test 1 was unmet by what merged. So when the
    FIRST segment is exactly `cd <literal-path>` and nothing relocates again, the scope is
    classified against THAT path instead of `input.cwd`. It returns null — keeping the veto — for a
    variable, a substitution, a glob, a `~`, a `cd` with flags, a `cd` that is not first, a second
    relocation, or any subshell. The resolved path is only a CANDIDATE: `classifyRepoScope` still
    has to find a real repo root there, so a `cd` into a nonexistent or non-repo directory lands on
    `indeterminate` and denies.

  Both remain deliberately conservative — a false veto costs a denial, which is the safe direction.

Originating incident: a throwaway git repo in the agent scratchpad, created to reproduce a bun
`--changed` defect in isolation for mt#3562, could not be seeded because `git add` was denied at a
path with no relationship to the project.

## Command parsing

`splitOnShellOperators` splits on `&&`, `||`, `;`, and `|`, **ignoring operators inside single or
double quotes** (mt#3788). Each segment is tokenized on whitespace; leading `VAR=value`
assignments are stripped; a segment whose first remaining token is not `git` or `gh` is ignored.

Quote-awareness was previously an accepted limitation, on the reasoning that a mis-split could
only cost a contrived false positive. It could not: a `|` inside a regex is the ordinary way to
write an alternation, so `grep -E 'block-git-gh-cli|git add|guard matcher' docs/` split into a
segment that literally read `git add` and was denied — with no git command being run at all.
An argument VALUE that merely mentions a denied command is not an invocation of it.

Unbalanced quotes fall back to the quote-blind splitter (`splitOnShellOperatorsUnquoted`) rather
than swallowing the remainder into one segment: over-splitting can only produce a spurious
denial, never a missed one, which is the direction to fail in.

**Still not a shell lexer, and not a security boundary.** `$(git ...)` subshells and
`sh -c "git push"` are not parsed. Both predate mt#3788 and are unaffected by it — that change
narrowed false positives without widening what slips through.

## Related

- mem#263 — the MCP-tools-only rule this guard enforces.
- `hook-files.mdc` — the guard index.
- mt#3703 — `block-secret-file-read` denying greps over source that merely mention a trigger
  token. Same over-fire family, different guard; fixed independently.
