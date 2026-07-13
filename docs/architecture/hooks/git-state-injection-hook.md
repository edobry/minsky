# Git-State Injection Hook

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Dispatcher status:** migrated onto the ADR-028 guard-dispatcher framework (Phase 2b, mt#2687) —
runs in-process via `dispatch-userpromptsubmit.ts`'s `GUARD_REGISTRY` entry `inject-git-state`;
`run()` uses `ctx.budgets.gitTimeoutMs` (D6) rather than re-deriving its own host cap. See
`guard-dispatcher-framework.md`.

A `UserPromptSubmit` hook (`.claude/hooks/inject-git-state.ts`) that injects
the current git state (branch name, working-tree status, ahead/behind counts
vs the default branch, and the 5 most-recent commits) into every turn's
`additionalContext` (mt#2275). Sibling of the current-time injection hook
(mt#2181); same architectural pattern, same override convention, same
structural-injection rationale (memory `08606f7c` — "structural injection
beats retrieval discipline").

**Hook file:** `.claude/hooks/inject-git-state.ts`

**Output formats:**

Collapsed (single line, when working tree is clean AND in sync with default
branch):

```
Current git state: on main, clean, in sync with last-fetched origin/main.
```

Expanded (multi-line, otherwise):

```
Current git state:
- Branch: task/mt-2275 (vs last-fetched origin/main: 3 ahead, 0 behind)
- Working tree: 2 modified, 1 untracked, 0 staged
- Recent commits on branch:
  abc1234 feat(mt#2275): add hook
  def5678 fix(mt#2275): R1 review
  ...
```

**Why this exists.** Claude Code's session-start system reminder includes a
`gitStatus` block (current branch, modified files, recent commits). These
values are captured once and never refreshed. Long sessions accumulate
divergence: branch switches, new merges to main, file edits — none of which
update the anchor. The agent then asserts stale state ("we're on main",
"the most recent commit was X") without any failure signal until a user
catches it. This is structurally identical to the time-anchor problem mt#2181
fixed.

**Performance budget:** <50ms per invocation. Per-command timeout derived
from the host-imposed cap in settings.json via
`readHostCap("inject-git-state.ts", undefined, { events: ["UserPromptSubmit"] })`
and `deriveBudgets(...).gitTimeoutMs` — matches sibling-hook convention
(see §Branch Freshness Guard for the budget-derivation pattern). At the
configured 5s cap, this yields ~510ms per command. Git commands invoked:

- `git rev-parse --is-inside-work-tree` (repo detection; handles worktrees
  and submodules correctly via git's own check, not a `.git`-existence walk)
- `git symbolic-ref --short HEAD` (branch name)
- `git symbolic-ref --short refs/remotes/origin/HEAD` (default branch, with
  `git config remote.origin.head` and main/master probes as fallbacks)
- `git status --porcelain=v1` (working-tree status)
- `git rev-list --left-right --count HEAD...origin/<default>` (ahead/behind
  in a single call)
- `git log --oneline -5 HEAD` (recent commits)

**No per-turn `git fetch`.** Ahead/behind is computed against the LOCAL
CACHE of `origin/<default>`. The hook fires on every UserPromptSubmit
(potentially hundreds per session); a network call per turn would regress
the budget by orders of magnitude. The output is explicitly labelled
"vs last-fetched origin/<X>" so the agent doesn't over-interpret the
comparison as live-remote-current. Sibling hooks like `check-branch-fresh.ts`
fetch because they run once per merge attempt — different cost class.

**Fail-open posture:** the hook bails silently (no `additionalContext` emitted)
when:

- `cwd` is not a git repository (per `git rev-parse --is-inside-work-tree`)
- the `HEAD` symbolic-ref lookup fails (detached HEAD, broken repo)
- any individual git command times out

Subsidiary failures (e.g., ahead/behind can't be computed because the branch
has no upstream) are tolerated — the snapshot still emits with the missing
fields filled with sensible defaults. The hook is informational; it should
never block the user prompt.

**Override mechanism:** Set `MINSKY_SKIP_GIT_STATE_INJECTION=1` (or `true` /
`yes`) to disable injection:

```bash
MINSKY_SKIP_GIT_STATE_INJECTION=1 claude
```

When the override fires, the hook emits an audit-log line to stdout
(`[inject-git-state] override active: ...`) and returns no
additionalContext. The audit line is not valid HookOutput JSON, so Claude
Code's hook-output parser logs it as "Ignoring non-JSON line on stdout" —
matching the sibling-hook audit convention.

**Env-var registration:** `MINSKY_SKIP_GIT_STATE_INJECTION` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788. The
override env-var name's source of truth lives in
`.claude/hooks/inject-git-state.ts` as the exported constant
`GIT_STATE_INJECTION_OVERRIDE_ENV` so the hook, tests, and rule documentation
cannot drift.

**Originating context:** mt#2275 follows from the 2026-05-24/30/31 incident
memo's open question #2 ("does the injection pattern generalize beyond
time?"). The memo named git state as the clearest candidate after time:
session-start system reminder captures it once; staleness produces
silently-wrong assertions; cost is bounded; value is high.

**Cross-references:**

- mt#2181 — `inject-current-time.ts` (architectural template; same pattern,
  same override convention)
- Memory `08606f7c` — Structural injection beats retrieval discipline
  (synthesis-level lesson; this hook is its second instance)
- Notion incident memo `371937f03cb481428aeaeedd67f7216f` — originating
  audit, open question #2
- `.claude/hooks/memory-search.ts` and `.claude/hooks/skill-staleness-detector.ts`
  — sibling injection hooks
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration
  contract this hook conforms to)
