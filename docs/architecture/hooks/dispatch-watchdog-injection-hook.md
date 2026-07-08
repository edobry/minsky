# Dispatch-Watchdog Injection Hook

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook (`.claude/hooks/inject-dispatch-watchdog.ts`) that injects a warning
when a subagent dispatch has gone silent (mt#2646). Fourth instance of the structural-injection
pattern after `inject-current-time` (mt#2181), `inject-git-state` (mt#2275), and
`inject-prod-state` (mt#2506); same cost-aware producer/consumer split and override convention.

**Producer / consumer split.** Detecting a stalled dispatch requires a DB query
(`subagent_invocations` + `system_events`) plus a per-session git subprocess — both fail the
≤50ms per-turn injection bar, so the mechanism is split the same way `inject-prod-state` is:

- **Producer:** `src/cockpit/dispatch-watchdog.ts` + `startDispatchWatchdogSweeper` in
  `src/cockpit/sweepers.ts` (wired at cockpit boot in `src/commands/cockpit/start-command.ts`).
  Every 5 minutes, queries `subagent_invocations` rows with `ended_at IS NULL` (dispatched, not
  yet Stop-classified) whose task is IN-PROGRESS or IN-REVIEW, computes each row's most recent
  activity signal (dispatch `started_at`, last commit on the session branch via `git log -1
--format=%ct` in the on-disk session workspace, last related `system_events` row), and flags
  any row silent for ≥ `DISPATCH_WATCHDOG_STALE_MS` (30m default). Writes the flagged set to
  `<state-dir>/dispatch-watchdog-cache.json`.
- **Consumer:** this hook reads ONLY the local cache and injects a warning naming each flagged
  dispatch when the flag set is non-empty; silent when empty or when no snapshot exists yet
  (an empty watchdog is the overwhelmingly common healthy case — warning before the first sweep
  tick would be pure noise, unlike `inject-prod-state`'s UNKNOWN-on-absence framing).

**Detection logic is pure and unit-tested.** `computeDispatchWatchdogFlags` in
`src/cockpit/dispatch-watchdog.ts` takes an injected clock and injected activity-signal lookups
(no I/O) — the same pattern the DB/git-touching producer wraps around it.

**Hook file:** `.claude/hooks/inject-dispatch-watchdog.ts`

**Output shape (only emitted when ≥1 dispatch is flagged):**

```
DISPATCH WATCHDOG: 1 in-flight subagent dispatch(es) appear stalled (no commit / PR event /
subagent_invocations activity past the stale window, last checked 2026-07-07T12:00:00.000Z):
  - mt#2646 (IN-PROGRESS, agentType=implementer, session=session-1): silent for 1h (last activity 2026-07-07T11:00:00.000Z)
Before assuming the dispatch is dead: probe recovery-relevant state in one call via the
session.status MCP tool with probe=true ... THEN apply the resume protocol documented in the
/orchestrate skill ...
```

**Paired recovery mechanisms (also shipped by mt#2646):**

- **Probe:** `session.status` (`src/adapters/mcp/session-workspace.ts`) gained an optional
  `probe: true` mode returning PR number + latest review state, commits-ahead-of-base, dirty-file
  count, and `handoff.md` presence/first-lines in one call. Shape assembly is the pure
  `buildDispatchRecoveryProbe` in `packages/domain/src/session/dispatch-recovery-probe.ts`.
- **Resume protocol:** the `/orchestrate` skill's "Dispatch watchdog and resume protocol" section
  documents the decision rule — uncommitted work → checkpoint-commit first; prefer
  SendMessage-resume of the same agent for fix rounds (memory `6038c0a1`); fresh dispatch into
  the EXISTING session only when the transcript is unusable.

**Why this exists.** During the mt#2607 burndown (~14 implementer dispatches, 2026-07-06/07), 5
dispatches ended without a usable completion report — two stalled silently mid-review-convergence
for 6.5h, one died with uncommitted work and no handoff, one died on an API error
mid-convergence, two stopped cleanly but pre-convergence. Every case required the orchestrator to
manually notice the silence and probe session state by hand; this hook surfaces the same signal
structurally, every turn.

**Performance budget:** producer tick queries a bounded set of in-flight rows (typically single
digits) plus one `git log` subprocess per distinct session — well within the 5-minute sweep
cadence. Consumer hook does a single local fs read + parse, no network, no git.

**Fail-open posture:** the hook is silent (no `additionalContext`) on a missing/unreadable/
malformed cache — this class deliberately does NOT escalate the way `inject-prod-state`'s
UNKNOWN/STALE/SEVERELY-STALE ladder does, because an empty or absent watchdog cache is not
itself evidence of a problem. The producer fails open too: no DB / a failed pass logs and leaves
the last-good cache in place.

**Override mechanism:** Set `MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION=1` (or `true` / `yes`) to
disable injection:

```bash
MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION=1 claude
```

When the override fires, the hook emits an audit-log line to stdout
(`[inject-dispatch-watchdog] override active: ...`) and returns no additionalContext — matching
the sibling-hook audit convention.

**Env-var registration:** `MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION` is registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override env-var name's source
of truth lives in `.claude/hooks/inject-dispatch-watchdog.ts` as the exported constant
`DISPATCH_WATCHDOG_INJECTION_OVERRIDE_ENV`; the cache filename + state-dir resolution are
duplicated between the hook and `src/cockpit/dispatch-watchdog.ts` (separate module graphs) and
kept in sync by contract.

**Cross-references:**

- mt#2646 — this hook's tracking task (watchdog detection + probe + resume protocol)
- mt#2607 — the burndown session that surfaced the originating incident
- mt#2506 `inject-prod-state.ts` — the architectural template (cost-aware producer/consumer split)
- mt#2275 `inject-git-state.ts` / mt#2181 `inject-current-time.ts` — sibling injection hooks
- mt#2234 — cockpit cadence sweep (the periodic-refresh host this producer piggybacks)
- mt#1735 / mt#1736 — `subagent_invocations` schema + tracker (the dispatch-time INSERT this
  producer reads as its in-flight signal)
- mt#2092 — `system_events` schema (the activity signal for PR/subagent events)
- Memory `08606f7c` — Structural injection beats retrieval discipline
- Memory `6038c0a1` — SendMessage-resume validation (the resume-protocol's step (b))
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
