# Subagent Merge Capability Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `PreToolUse` hook on `mcp__minsky__session_pr_merge` denies the call when
the hook-input `agent_id` is present (a subagent invocation) AND no valid,
unexpired capability grant covers the resolved task. This implements
ADR-028's D5 decision: subagent-initiated merges are DEFAULT-DENY,
overridable only by an explicit TTL-bound capability grant issued by the
orchestrator.

**Hook file:** `.claude/hooks/block-subagent-merge-without-grant.ts`. Shared
grant-store module: `.claude/hooks/merge-grant-store.ts`. Both are compiled
from `.minsky/hooks/` canonical sources per the mt#2304 hooks-compile
pipeline (`bun run src/cli.ts compile --target claude-hooks`).

**Why this exists.** Prior to this guard, `session_pr_merge` had NO subagent
gate at all — only the raw `gh api PUT` bypass path was gated
(`block-subagent-bypass-merge.ts`). Instruction-tier compliance ("do NOT
merge the PR" in the dispatch prompt) was the only control, and it failed 2
of 6 times during the mt#2607 burndown (mt#2612 PR #1792, mt#2615 PR #1795 —
both merged by subagents despite explicit no-merge instructions; both
outcomes happened to be sound, but the mechanism that would have prevented
an unsound one did not exist).

**How it works:**

1. Detects subagent context via `agent_id` (mirrors
   `block-subagent-bypass-merge.ts`'s `isSubagentContext`) — a non-empty
   string means subagent; absent/empty means main-thread (unaffected by this
   guard).
2. Resolves the task id: prefers `tool_input.task` (the string param
   `session_pr_merge` accepts directly), falling back to parsing the current
   git branch in `cwd` for the `task/mt-<id>` convention — a self-contained,
   DB-free strategy (deliberately NOT the DB-backed resolution
   `record-subagent-invocation.ts` uses, which would violate the hooks'
   self-containment invariant this guard preserves).
3. Reads the shared grant store (`~/.local/state/minsky/merge-grants.json`
   by default; `MINSKY_STATE_DIR` override — same state-dir resolution as
   `inject-prod-state.ts`'s `getStateDir()`).
4. Searches for a grant matching the resolved task id (normalized:
   lowercase, `#`/whitespace stripped — same convention as
   `check-task-spec-read.ts`), not expired
   (`now < Date.parse(issuedAt) + ttlMs`), and matching `agentScope`
   (`"any"` or the exact `agent_id`).
5. Match found → allow (audit line to stdout naming the matched grant — non-JSON,
   so the hook-output parser ignores it, per the sibling-hook audit convention). No
   match → deny with a structured message naming the resolved task id and
   the issuance command to run instead.

**Capability-grant mechanism (ADR-028 D5).** A grant is a JSON record
`{ taskId, agentScope, issuedAt, ttlMs, prNumber?, issuedBy?, reason? }`
appended to the shared store. Grants are scoped primarily by `taskId` (per
D5: "scoped to (parentSessionId, taskId)" — the parent session id is folded
into `issuedBy` for audit purposes rather than as a matching key, since the
guard has no reliable way to observe it at merge time). `agentScope`
defaults to `"any"` (any subagent dispatched for the task) since the
harness's per-dispatch `agent_id` is rarely knowable at issuance time; it
can be set to a specific `agent_id` to scope tighter. `prNumber` is accepted
and persisted for forward compatibility (grants issued after PR creation)
but is NOT yet resolved/matched by the guard — see Known limitations.

**Orchestrator-side issuance surface:** `scripts/grant-subagent-merge.ts`.
An orchestrator (main agent, or a parent coordinating a burndown-style wave
of subagent dispatches) runs it BEFORE the subagent's merge attempt:

```bash
bun scripts/grant-subagent-merge.ts --task mt#2651 --ttl-minutes 30 \
  [--agent-scope any] [--issued-by "<note>"] [--reason "<note>"]
```

Default TTL is 30 minutes (the order of a typical bounded subagent dispatch,
per ADR-028 D5). `--dry-run` previews the grant without writing it. The
script imports `merge-grant-store.ts`'s pure read/write/match functions
directly (from the canonical `.minsky/hooks/` source) so the grant schema
and matching logic live in exactly one place, shared between guard and
issuer — not duplicated.

**Fail-open posture:** fail-open is reserved for GENUINE grant-store read
errors (the store file exists but is unreadable, or its JSON is malformed).
A CONFIRMED state — the store file simply doesn't exist yet (ENOENT), or
parses cleanly but has no matching entry — is NOT a fail-open case; it is
the default-deny path doing its job. An unresolvable task id is treated the
same way (no grant can match an unknown task → deny), not as a store-read
error.

**Override mechanism:** Set `MINSKY_SKIP_MERGE_GRANT_CHECK=1` (or `true` /
`yes`) in your environment before invoking the tool:

```bash
MINSKY_SKIP_MERGE_GRANT_CHECK=1 minsky session pr merge ...
```

The override is **audit-logged to stdout** (agent_id, ISO timestamp). Use
only when the denial is a confirmed false positive — e.g. the
grant-issuance mechanism itself is broken and the merge has been
independently verified safe.

**Env-var registration:** `MINSKY_SKIP_MERGE_GRANT_CHECK` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported
constant `MERGE_GRANT_OVERRIDE_ENV`. The issuance script
(`scripts/grant-subagent-merge.ts`) has no override — deciding to run it IS
the authorization; auditability comes from the grant record's
`issuedBy`/`reason` fields.

**Known limitations:**

- `prNumber`-scoped grants are accepted by the schema and the issuance
  script but NOT resolved/matched by the guard yet — `session_pr_merge`'s
  `tool_input` carries no PR number, and resolving one would require an
  additional network call (`gh pr view`) the guard does not currently make.
  Task-id matching covers the documented use case; PR-number matching is a
  documented forward-compatibility slot, not a live behavior.
- Task-id resolution falls back to git-branch parsing only when
  `tool_input.task` is absent; a subagent whose dispatch omits `task` AND
  whose branch doesn't follow the `task/mt-<id>` convention resolves to an
  unmatchable (and therefore denied) task id — this is intentional
  default-deny behavior, not a bug.
- No dispatcher/registry integration yet — ADR-028's D1-D4 guard-dispatcher
  consolidation (mt#2650) had not landed as of this guard's authoring, so it
  ships as a standalone `.claude/settings.json` registration per the ADR's
  explicit Migration Plan Phase 3 ("Independent; can start immediately").
  When mt#2650 lands, this guard is a migration candidate for Phase 5.

**Cross-references:**

- mt#2651 — this guard's tracking task
- ADR-028
  (`docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md`) §D5 —
  the design decision this guard implements
- mt#2618 — parent umbrella; mt#2650 — the D1-D4 dispatcher/registry
  consolidation (future migration target)
- mt#2612 PR #1792, mt#2615 PR #1795 — originating incidents (subagent
  merges despite explicit no-merge instructions)
- `.claude/hooks/block-subagent-bypass-merge.ts` — structural template (the
  ADR explicitly calls this guard "structurally identical in shape")
- `.claude/hooks/merge-grant-store.ts` — shared grant schema + matching
  logic
- `scripts/grant-subagent-merge.ts` — orchestrator-side issuance surface
- `.claude/hooks/check-task-spec-read.ts` — task-id normalization
  convention this guard mirrors
- `.claude/hooks/inject-prod-state.ts` — state-dir resolution convention
  this guard mirrors
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration
