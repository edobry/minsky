# Guard-Health Tracker + Escalation Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2208 discipline) — full incident
> narration, design rationale, and cross-references for this mechanism. The compiled rule
> corpus carries only a terse index entry; this file is the durable detail.

## Why this exists

The mt#2806 gap-analysis week found three classes of silent guard-layer failure that no
agent or operator noticed until manual investigation: one merge gate crashed 18/18 times over
two days (`ENOENT: posix_spawn 'git'`, mt#2810), four gates crashed together on two separate
days, and one guard skipped its core check on 12/12 fires. Every one of these guards has a
documented fail-open posture — a crash is indistinguishable from "ran clean and permitted" at
the point of decision. This tracker closes that visibility gap: it makes guard-layer failures
a **visible, escalating signal** instead of a silent permit, following the same architectural
shape as the MCP disconnect tracker (`src/mcp/disconnect-tracker.ts`, mt#1645/1682) and the
subagent dispatch tracker (`src/mcp/subagent-dispatch-tracker.ts`, mt#1735-1738): append-only
log + aggregate surface + threshold escalation.

## Capture plumbing — two paths

**(a) ADR-028 dispatcher-migrated guards (automatic).** `.minsky/hooks/dispatcher.ts`'s guard
loop wraps every matched guard's `mod.run()` in a try/catch. On a thrown error, it already
wrote a stderr diagnostic line (`[dispatcher:<event>] guard=<name> threw: <message>`); mt#2812
adds a call to `recordGuardError({ guardName, event, error, toolName, sessionId })` in the same
catch block, immediately after that line. This covers every guard registered in
`registry.ts`'s `GUARD_REGISTRY` — both the `PreToolUse` family (`check-guessed-session-path`)
and the full `UserPromptSubmit` family (16 guards as of mt#2812) — with **zero per-guard code
changes**.

**(b) Standalone (non-dispatcher) hooks.** `recordGuardCheckSkip({ guardName, event, reason,
toolName, sessionId })` is exported from the same shared module for a standalone hook's own
catch block to call directly, when the guard's own logic catches an internal error and takes
its fail-open path WITHOUT throwing (so the dispatcher-side automatic capture in (a) never
sees it). This helper is built and ready to adopt; wiring it into the ~15 existing standalone
guards' own catch blocks is deliberately **not** done as part of mt#2812 — see "Does NOT
cover" below.

## The shared module: `.minsky/hooks/guard-health.ts`

Dependency-free per `.minsky/hooks/SPEC.md`'s invariant (no `src/` imports — hooks keep
working even when the main codebase has type errors). Exports:

- `recordGuardError(input, options?)` / `recordGuardCheckSkip(input, options?)` — append one
  JSON line to the log. Both wrap their entire body in try/catch and NEVER throw — recording
  must never break guard execution, mirroring `logCalibrationRecord`'s (dispatcher.ts D4)
  swallow-all posture.
- `readGuardHealthEvents(options?)` — parse the on-disk JSONL log, skipping malformed lines.
  Missing file or read error resolves to `[]`, never a throw.
- `computeGuardHealthSummary(events, now)` — the pure aggregation core (fault-injection test
  target): per-guard error counts (24h/7d) and a **consecutive-failure streak**.
- `getGuardHealthSummary(options?)` — convenience wrapper: read + aggregate, fail-safe.

**Persisted event shape:** `{ timestamp, guardName, event, kind: "error" | "check-skip",
errorClass?, message, toolName?, sessionId? }`. One JSON object per line, append-only, at
`~/.local/state/minsky/guard-health-log.jsonl` (honors `MINSKY_STATE_DIR` override, mirroring
`disconnect-tracker.ts`'s `getStateDir()`).

**Consecutive-streak semantics.** Since this tracker records only errors/check-skips (not
every successful fire — that's mt#2597's scope, see below), a guard's "streak" is computed
purely from its own error-log entries: walking backward from the most recent entry, each
additional entry counts toward the streak as long as the gap to its predecessor is `<=
STREAK_RESET_GAP_MS` (24h — reusing decision-defaults.mdc's project-wide "burst-detection
windows: 24h" calibration). A gap larger than that starts a fresh streak. This lets a guard
firing sparsely-but-reliably across a multi-day incident (the mt#2806 "18/18 over two days"
evidence) still count as one continuous streak, while an isolated failure a week later starts
over.

## Escalation thresholds

Grounded per the mt#2812 spec's explicit calibration ("a gate that errors on 3+ consecutive
fires is already pathological per this week's data") and decision-defaults.mdc §Thresholds:

- `escalation: "none"` — no guard has a streak `> ATTENTION_STREAK_THRESHOLD` (1), i.e. fewer
  than 2 consecutive failures.
- `escalation: "attention"` — at least one guard has 2+ consecutive failures (streak `>
ATTENTION_STREAK_THRESHOLD`).
- `escalation: "critical"` — at least one guard has 3+ consecutive failures (streak `>
CRITICAL_STREAK_THRESHOLD` (2)) — the spec's explicit pathological threshold.

The overall `escalation` field is the max severity across every guard; `criticalGuards` /
`attentionGuards` name which guards are at each tier (disjoint sets).

## Read side + surfacing

**`debug_systemInfo.guardHealth`** — `src/mcp/guard-health-tracker.ts`'s `GuardHealthTracker`
singleton. This is a **duplicate** implementation of the read+aggregate logic in
`.minsky/hooks/guard-health.ts`, not a cross-import: the root `tsconfig.json`'s `"include"` is
`["src", "types", "tests", ...]` — `.minsky/` is not part of that program, and the hooks tree
is intentionally self-contained. Precedent for duplication-over-cross-import:
`.minsky/hooks/mcp-daemon-staleness-detector.ts` inlines its own daemon-state reader rather
than importing `src/mcp/daemon-state.ts`, for the same reason in the opposite direction. Since
guard processes are short-lived (a fresh Bun process per hook event, not a long-running
server), `GuardHealthTracker.getSummary()` re-reads the on-disk log fresh on every call —
unlike `DisconnectTracker`'s in-memory ring buffer, there is no persistent in-process event
list to maintain.

**Cockpit widget (`guard-health`)** — `src/cockpit/widgets/guard-health.ts`. Mirrors
`embeddings-health.ts`'s pattern exactly: `GuardHealthTracker.getInstance().getSummary()`
wrapped in try/catch, degrading to `{ state: "degraded" }` on any error. Registry-gated per
mt#2294 — no per-widget enable flag, no new widget architecture.

**UserPromptSubmit injection (`guard-health-escalation-detector`)** —
`.minsky/hooks/guard-health-escalation-detector.ts`. ADR-028-registered (added directly to
`GUARD_REGISTRY`'s `UserPromptSubmit` family; no dispatcher/settings.json changes needed
beyond the family's shared host-cap budget bump, per this doc's own "Dispatcher host-cap
budget model" section). Reads `getGuardHealthSummary()` and, only when overall escalation is
`"critical"`, injects a warning naming every critical guard, its streak, and its last error
message. No de-duplication or per-session "already warned" tracker — the warning re-surfaces
every turn while any guard remains critical, mirroring `inject-current-time.ts` /
`inject-git-state.ts`'s "fresh info every turn" posture: a dead gate silently forgotten after
one mention would defeat the point of an escalating signal.

## Fail-safe posture

Every layer swallows its own errors:

- `recordGuardError` / `recordGuardCheckSkip` — wrapped in try/catch; a broken fs (missing
  directory, permission denied, disk full) never propagates.
- `readGuardHealthEvents` / `getGuardHealthSummary` — a missing or unreadable log file
  degrades to `[]` / the zero-filled summary, never a throw.
- `GuardHealthTracker.getSummary()` (the `debug_systemInfo` read side) and the
  `guard-health-escalation-detector` guard's `run()` both wrap their own logic in try/catch as
  defense-in-depth, even though the functions they call already guarantee no-throw.

This tracker itself must never become the next silent-failure incident it exists to prevent.

## Covers / Does NOT cover

**Covers:** in-process guard errors/crashes for every ADR-028 dispatcher-migrated guard
(automatic); check-skips on fail-open paths (via the shared helper, for hooks that call it);
aggregation, streaks, and escalation tiering; operator/agent-facing surfacing via
`debug_systemInfo`, the cockpit widget, and the UserPromptSubmit injection.

**Does NOT cover:**

- **A guard returning the wrong verdict without erroring** (a fail-open guard that runs clean
  but reasons incorrectly and permits something it should have denied). This tracker only sees
  thrown errors and explicit check-skip calls. Owner: the evaluation-loop RFC (Notion
  `392937f0`, task mt#2589) — its canary-verification design is the mechanism that would
  distinguish a broken guard from a wrong-but-clean one.
- **Out-of-process deaths** — a guard/dispatcher process killed by `process.exit()`, an OOM, or
  a host-level SIGKILL before/during the `catch` block never gets a chance to call
  `recordGuardError`. This is exactly the mt#2835 regression class (`auto-session-title.ts`'s
  ungated module-level `main().catch(() => process.exit(0))` killing the whole dispatcher
  process). Owner: `.minsky/hooks/guard-entrypoint-gate.test.ts` (static scan for ungated
  `main()` calls) and `.minsky/hooks/dispatch-userpromptsubmit.e2e.test.ts` (e2e canary
  spawning the real dispatcher process end-to-end).
- **Retrofitting the ~15 existing standalone hooks** to call the new shared helper. Built and
  ready to adopt; wiring each individual hook's catch block is out of scope per mt#2812's own
  scope guard ("do NOT fix individual guard bugs (siblings own those)") — touching each hook's
  file is exactly the class of per-guard change that guard excludes. Owner: each hook's own
  maintainer, or a dedicated follow-up task, at adoption time.
- **Per-fire logging of every SUCCESSFUL guard fire** and the canary-verification mechanism.
  Owner: mt#2597 (part of the evaluation-loop RFC, mt#2589).

## Cross-references

- mt#2806 — parent umbrella (gap-analysis week that surfaced the evidence)
- mt#2812 — this task
- `src/mcp/disconnect-tracker.ts` (mt#1645/1682) — architectural precedent
- `src/mcp/subagent-dispatch-tracker.ts` (mt#1735-1738) — architectural precedent
- `.minsky/hooks/dispatcher.ts` — capture path (a)
- `.minsky/hooks/guard-health.ts` — the shared record/read/aggregate module
- `.minsky/hooks/guard-health-escalation-detector.ts` — the UserPromptSubmit consumer
- `src/mcp/guard-health-tracker.ts` — the src/-side reader for `debug.systemInfo`
- `src/cockpit/widgets/guard-health.ts` — the cockpit widget
- mt#2835 — the out-of-process-death regression this tracker's "Does NOT cover" names
  explicitly (its own `guard-entrypoint-gate.test.ts` / `dispatch-userpromptsubmit.e2e.test.ts`
  own that class)
- mt#2589 / mt#2597 — the evaluation-loop RFC and its fire-log task, which own
  verdict-quality and full successful-fire logging respectively
