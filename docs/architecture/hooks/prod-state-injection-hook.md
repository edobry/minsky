# Prod-State Injection Hook

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Dispatcher status:** migrated onto the ADR-028 guard-dispatcher framework (Phase 2b, mt#2687) —
runs in-process via `dispatch-userpromptsubmit.ts`'s `GUARD_REGISTRY` entry `inject-prod-state`;
see `guard-dispatcher-framework.md`.

A `UserPromptSubmit` hook (`.claude/hooks/inject-prod-state.ts`) that injects the current
shared/PROD state (count of applied migrations + the latest-applied-migration timestamp)
into every turn's `additionalContext` (mt#2506). Third instance of the structural-injection
pattern after `inject-current-time` (mt#2181) and `inject-git-state` (mt#2275); same override
convention; same rationale (memory `08606f7c` — "structural injection beats retrieval
discipline").

**Producer / consumer split (the cost-aware variant).** Unlike its siblings — which read
_local_ state cheaply per turn — prod state lives behind a network query. Per `08606f7c`'s
≤50ms / non-churny bar, a per-turn prod-DB query is disallowed. So the mechanism is split:

- **Producer:** `src/cockpit/prod-state-cache.ts` + `startProdStateRefreshSweeper` in
  `src/cockpit/server.ts` (wired at cockpit boot in `src/commands/cockpit/start-command.ts`).
  Piggybacks the cockpit cadence sweep (sibling of the mt#2265 ask-advancement sweeper):
  once at boot, then every ~10m, it reads `drizzle.__drizzle_migrations` via the persistence
  provider's `getRawSqlConnection()` and writes a small local cache file
  (`<state-dir>/prod-state-cache.json`).
- **Consumer:** this hook reads ONLY the local cache (cheap fs read, no network) and injects
  the snapshot, labelled with its last-checked age — the same "last-fetched/last-checked"
  honesty tradeoff `inject-git-state` uses for ahead/behind.

**Hook file:** `.claude/hooks/inject-prod-state.ts`

**Output formats (three shapes):**

Fresh (cache age ≤ `PROD_STATE_STALENESS_MS` = 30m):

```
Current prod state (last-checked 2026-06-16T20:00:00.000Z, 5m ago): 48 migrations applied; latest applied 2026-06-16T14:02:00.000Z. Treat this as ground truth for prod-state claims this turn ...
```

Stale (cache age > 30m — the cadence sweep may be stopped):

```
Current prod state snapshot is STALE (last-checked ..., 2h ago). ... re-verify the prod migration ledger before asserting prod state.
```

Unknown (no cache yet):

```
Current prod state: UNKNOWN (no local snapshot yet). Do NOT assert prod state ("nothing has touched prod") from memory — read the prod migration ledger (drizzle.__drizzle_migrations) to verify before asserting.
```

**Why this exists.** R10 of the assertion-without-verification family (family tracker
`b0b294ab`, 2026-06-16): the agent told the principal "nothing has touched prod" without
reading the prod ledger — false (migrations had auto-applied via the `initialize()`
side-channel). That is an objectively-verifiable factual claim about shared/prod state, made
in a status report, that gates NO tool call — so the tier-1 tool-boundary evidence gate
(mt#2488) structurally cannot reach it. This hook is the no-tool-boundary sibling: it puts the
prod ground truth in front of the agent every turn so the claim is informed, not asserted
from stale memory.

**Performance budget:** <50ms per invocation — the hook does a single local fs read + parse,
NO network and NO git. The expensive prod-DB read is amortized into the producer's ~10m
cadence sweep, never the per-turn hook.

**Fail-open posture:** the hook emits an explicit "UNKNOWN" note (never crashes, never blocks
the prompt) when the cache is absent, unreadable, or malformed; and a "STALE" note when the
snapshot is older than the staleness threshold. The producer fails open too: no DB / an
unreadable ledger / a failed sweep pass logs and leaves the last-good cache in place rather
than blanking it.

**Override mechanism:** Set `MINSKY_SKIP_PROD_STATE_INJECTION=1` (or `true` / `yes`) to
disable injection:

```bash
MINSKY_SKIP_PROD_STATE_INJECTION=1 claude
```

When the override fires, the hook emits an audit-log line to stdout
(`[inject-prod-state] override active: ...`) and returns no additionalContext — matching the
sibling-hook audit convention.

**Env-var registration:** `MINSKY_SKIP_PROD_STATE_INJECTION` is registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override env-var name's
source of truth lives in `.claude/hooks/inject-prod-state.ts` as the exported constant
`PROD_STATE_INJECTION_OVERRIDE_ENV`; the cache filename + state-dir resolution are duplicated
between the hook and `src/cockpit/prod-state-cache.ts` (separate module graphs) and kept in
sync by contract.

**Verification artifact:** `scripts/smoke-prod-state-cache.ts` live-verifies the producer's
real ledger query (env-gated on `DATABASE_URL`; skips gracefully without it).

**Cross-references:**

- mt#2506 — this hook (the R10 no-tool-boundary seam, split from tier-1 mt#2488)
- mt#2485 — parent reframe; mt#2488 — tier-1 tool-boundary evidence gate (the write-side
  sibling); mt#2277 — unmerged-migration guard (also write-side)
- mt#2275 `inject-git-state.ts` / mt#2181 `inject-current-time.ts` — sibling injection hooks
- mt#2234 — cockpit cadence sweep (the periodic-refresh host); mt#2265 — ask-advancement
  sweeper (the sweeper pattern this producer mirrors)
- Memory `08606f7c` — Structural injection beats retrieval discipline (synthesis-level lesson;
  this hook is its third instance and the first cost-aware/cached variant)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
