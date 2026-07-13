# Current-Time Injection Hook

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Dispatcher status:** migrated onto the ADR-028 guard-dispatcher framework (Phase 2b, mt#2687) —
runs in-process via `dispatch-userpromptsubmit.ts`'s `GUARD_REGISTRY` entry `inject-current-time`;
see `guard-dispatcher-framework.md`.

A `UserPromptSubmit` hook (`.claude/hooks/inject-current-time.ts`) that
injects the current date, day of week, and UTC timestamp into every turn's
`additionalContext` (mt#2181). This is the structural fix for the
date-staleness pattern: the agent has no reliable way to know "now" without
running `date`, and the session-start system reminder anchors the date once
but goes stale silently as conversations run for hours or days.

**Hook file:** `.claude/hooks/inject-current-time.ts`

**Output format (single line, injected as additionalContext):**

```
Current time: Saturday 2026-05-30 16:39:00 EDT-0400 (UTC: 2026-05-30T20:39:00Z)
```

Includes:

- Day of week (so the agent can answer "what day is it?" without computing).
- ISO local date (`YYYY-MM-DD`) — the canonical reference format.
- Local time with timezone abbreviation AND signed numeric offset (both
  useful; the offset is unambiguous, the abbreviation is human-readable).
- UTC ISO timestamp — canonical for scheduling, logging, cross-region work.

**Always fires.** No skip-on-trivial-prompt logic. The hook is cheap (<1ms,
no I/O) and the cost of injection is bounded; the cost of staleness is
unbounded (false dates in PR bodies, wrong scheduling, missed soak windows).

**Override mechanism:** Set `MINSKY_SKIP_TIME_INJECTION=1` (or `true` / `yes`)
to disable injection:

```bash
MINSKY_SKIP_TIME_INJECTION=1 claude
```

When the override fires, the hook emits an audit-log line to stdout
(`[inject-current-time] override active: ...`) and returns no
additionalContext. The audit line is not valid HookOutput JSON, so Claude
Code's hook-output parser logs it as "Ignoring non-JSON line on stdout" —
matching the sibling-hook audit convention (`parallel-work-guard.ts`,
`check-branch-fresh.ts`). Use only when intentionally testing the agent's
stale-context handling.

**Env-var registration:** `MINSKY_SKIP_TIME_INJECTION` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788. The
override env-var name's source of truth lives in
`.claude/hooks/inject-current-time.ts` as the exported constant
`TIME_INJECTION_OVERRIDE_ENV` so the hook, tests, and rule documentation
cannot drift.

**Originating incidents (2026-05-30):**

- **R1** (within ~30 min of session start): agent stated "May 24 (Saturday)"
  while computing mt#2061's soak-period earliest-eligible date. May 24 was
  Sunday. The cascade produced a wrong "earliest eligible" date in the spec
  amendment. The `date` command was available and would have taken <1
  second.
- **R2** (same session, ~30 min after R1, AFTER memory `53086971` was
  created with "always run `date` before stating calendar facts"): user
  asked "what's the status of this." Agent responded with a status report
  stating "scheduled for Monday May 25" and "soak completes Tuesday May 26"
  — without re-checking the date. Actual date was Saturday May 30; the
  routine had fired 5 days earlier.

**Why the memory-tier fix failed within minutes** (motivating the hook
escalation): the memory-search hook injects memories that match keywords in
the USER'S prompt; "what's the status of this" has no calendar keywords →
memory not surfaced. Even with the memory fresh in working context from one
turn earlier, the trigger condition (action-time date assertion) doesn't
fire on user prompts. The memory-tier fix is structurally incapable of
preventing the action-time class of this failure.

**Why the hook tier works:** the hook fires on EVERY UserPromptSubmit
regardless of prompt content. Injecting current time into `additionalContext`
makes it present in every turn's context whether the agent looks for it or
not — same architectural pattern as `memory-search.ts` (injects relevant
memories) and `skill-staleness-detector.ts` (injects stale-file warnings).

**Performance:** <1ms per invocation (single `new Date()` + `Intl.DateTimeFormat`
calls; no I/O, no subprocess, no MCP call). The hook is registered with a
5-second timeout — vastly larger than needed, matching the sibling-hook
convention.

**Cross-references:**

- Memory `53086971` — bridge entry; retires when this hook has been live
  for a full session without an R3 incident.
- `feedback_distributed_state_local_view_insufficient` — sibling family
  member, also escalated to hook tier (`parallel-work-guard.ts`) after 3
  incidents. This hook escalates after 2 incidents in the same session
  because the cost-per-recurrence is asymmetric (parallel-work loses hours
  of work; date-staleness produces silently-wrong artifacts that may not
  surface for days).
- `.claude/hooks/memory-search.ts` — architectural template.
- `.claude/hooks/skill-staleness-detector.ts` — sibling discipline hook.
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration
  contract this hook conforms to).
