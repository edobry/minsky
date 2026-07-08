# Parallel-Work Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `mcp__minsky__session_start` blocks sessions whose in-scope files overlap
an open PR or a commit merged to main in the last 24 hours. This is the Tier-3 structural
ceiling for the parallel-work ladder (mt#1362); the Tier-2 floor lives in `/plan-task` gate
criterion (g) and `/implement-task` §0a.

**Hook file:** `.claude/hooks/parallel-work-guard.ts`

**Checks run:**

1. Open-PR sweep (**BLOCKING**) — any open PR whose changed files overlap the task's `## Scope` → `In scope` list. This is the genuine merge-conflict signal (an _unmerged_ concurrent branch).
2. Recently-merged sweep (**ADVISORY** — mt#2337) — commits on the repo's **default branch** (auto-detected via `git symbolic-ref` / `git remote show origin` / probes for `origin/main` and `origin/master`; only when all probes fail does the sweep skip with a warning) in the last 24 hours touching in-scope paths. `session_start` clones the remote fresh every time, so the new session branch already includes these commits — they **cannot** produce a merge conflict. Surfaced as a **non-blocking warning** ("review recent changes to avoid duplicate work"), not a block. This eliminated the sequential-follow-up false positive (editing a file you just merged no longer denies `session_start`); stale-base hazards are covered separately by `check-branch-fresh.ts`.

**Structural-config exemption (mt#1587):** Files in `STRUCTURED_CONFIG_ALLOWLIST`
(currently `.claude/settings.json` and `.claude/settings.local.json`) are exempted
from collision detection when the change is **append-only into JSON arrays** — i.e.,
two PRs each adding a new entry to a hooks array structurally cannot conflict on
intent; only on textual git-merge resolution (which 3-way merge handles
automatically). The check is **fail-closed**: any fetch failure, parse error, or
non-append-only diff (re-ordering, modification, key changes) preserves the
collision. Each exempted file emits an audit warning so operators can see what
was filtered. The override below is therefore rarely needed for the pure-hook-PR
case but remains the escape valve for non-append-only changes and for files
outside the allowlist.

**On hit:** an **open-PR** overlap blocks `session_start` with a structured message listing the
colliding PR, overlapping files, and four recommended actions (wait / coordinate / reframe /
override). A **recently-merged** overlap does NOT block — it emits a non-blocking advisory warning
naming the commit and overlapping files (mt#2337).

**Override mechanism:** Set `MINSKY_FORCE_PARALLEL=1` in your environment before invoking the tool:

```bash
MINSKY_FORCE_PARALLEL=1 minsky session start --task mt#<id>
```

The override is **logged to session stdout** (task ID, ISO timestamp).
The line is visible in the session transcript but is **not** written to a durable
audit file — once the session log is rotated, the record is gone. Use only when
parallel work has been explicitly acknowledged and coordinated. After mt#1587 the
override is rarely needed for routine hook PRs (settings.json append-only diffs
no longer collide); it remains in scope for non-append-only changes,
non-allowlisted files, and operator-judgment overrides.

**When the hook warns but permits:** If the spec lacks a parseable `## Scope` → `**In scope:**`
section, the hook emits a warning to stdout and allows the session_start to proceed.

### Duplicate-child matcher (mt#1435)

The same hook ALSO fires on `mcp__minsky__tasks_create` when the `parent` argument is set —
the upstream-of-session*start variant of the same guard. The session_start sweep and the
`/plan-task` gate (g) both run at the \_planning* boundary; when an umbrella is decomposed,
minutes-to-hours can pass between the gate read and the actual `tasks_create` calls, during
which a concurrent agent's children can land. This matcher fires at the _mutating action_,
so it catches the concurrent-decomposition case regardless of that time gap.

**How it works:**

1. On a `tasks_create` with `parent` set, enumerate the parent's children via a
   **hybrid** strategy that avoids a per-child N+1 (each `minsky tasks get` costs
   ~2s of CLI startup): `minsky tasks children <parent>` for the IDs, then ONE
   bulk `minsky tasks list --json` call to resolve every **active** child
   (TODO/PLANNING/READY/IN-PROGRESS/IN-REVIEW/BLOCKED). Only **terminal-state**
   children (DONE/CLOSED/COMPLETED — excluded from the default list) fall back to
   a per-child `minsky tasks get <id> --json`. So the common case is 2 calls
   regardless of child count. The fetch is still latency-bounded so it can't blow
   the 30s PreToolUse host cap: a `TASKS_CHILDREN_FETCH_CAP = 25` hard cap, a
   `DUP_GUARD_CLI_TIMEOUT_MS = 4000` per-call timeout (must clear the ~2s CLI
   cold-start), AND a
   `DUP_GUARD_OVERALL_BUDGET_MS = 20000` wall-clock budget that hard-breaks the
   per-child fallback early (visible warning + partial-set check —
   fail-open-on-budget). **ALL statuses** are enumerated
   (TODO / PLANNING / IN-PROGRESS / IN-REVIEW / DONE / CLOSED) — a concurrent
   decomposition's children are typically still TODO/IN-PROGRESS at file-time, so a
   terminal-status-only filter would miss exactly the case this exists to catch.
2. Tokenize the new title and each child title into lowercase 4+-char non-stopword tokens
   (domain nouns are deliberately NOT stopworded — they are the duplicate signal).
3. If the new title shares ≥ `DUPLICATE_TOKEN_THRESHOLD` (2) substantive tokens with any
   existing child, BLOCK with a structured message naming the offending child's id, status,
   and the overlapping tokens.

**Fail-open posture:** a no-parent create is a no-op; an unreadable children list is
warn-and-permit; an individual unreadable/malformed child is skipped (not fatal); a
wall-clock-budget exhaustion checks the partial set with a visible warning; and any
unexpected exception is caught, logged to stderr, and fails OPEN (permit) — so the
guard can never silently block.

**Override mechanism:** Set `MINSKY_FORCE_DUPLICATE_OK=1` in your environment before the
`tasks_create` to bypass with an audit line on stdout naming the parent, title, and the
would-be duplicate match. The override env var is registered in `HOOK_ONLY_ENV_VARS`
(`packages/domain/src/configuration/sources/environment.ts`) per the
`custom/no-unregistered-minsky-env-var` rule (mt#1788).

**Mid-session-reachable override (mt#2658, ADR-028 D8):** the env var above is read from the
harness's launch-time process env — a value set via `Bash` mid-session never reaches this
hook's sibling subprocess, so an agent that hits a false-positive DURING a session cannot
self-serve `MINSKY_FORCE_DUPLICATE_OK=1` (the originating incident below hit exactly this and
worked around it by retitling the child, which is an anti-pattern — see
`feedback_use_sanctioned_cli_override_for_mcp_scoped_guards_dont_retitle_to_dodge`). The
reachable alternative is a TTL-bound, reason-mandatory grant file:

```bash
bun scripts/grant-guard-override.ts --guard duplicate-child-matcher \
  --scope mt#2370 --reason "distinct sibling, not a concurrent duplicate" [--ttl-minutes 30]
```

The guard consults this channel (via `.minsky/hooks/dispatcher.ts`'s `checkOverride()`, scoped
to the parent task id) whenever `MINSKY_FORCE_DUPLICATE_OK` isn't already set; a matching,
unexpired grant bypasses with the same audit-line shape, additionally naming
`source=grant reason="<the grant's reason>"`. See `.minsky/hooks/guard-grant-store.ts` for the
grant schema and `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` §D8 for the
design rationale (generalizes mt#2651's merge-grant store from a single guard/scope pair to
any `(guardName, scope)` pair).

**Originating incident:** R6 of the parallel-work family (2026-06-10) — while decomposing
umbrella mt#2370, an agent filed four duplicate children (mt#2403-2406) of a concurrent
agent's mt#2397 (DONE) / mt#2398 (IN-PROGRESS) / mt#2399 because gate (g) read "no subtasks"
~80 minutes before the `tasks_create` calls. See family memory `fe68f2a7`; the Tier-2 floor
complement is `/plan-task` gate (g) parent-children enumeration (mt#1434).
