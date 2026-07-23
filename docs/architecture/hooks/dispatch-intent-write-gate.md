# Dispatch-Intent Write Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `PreToolUse` hook on `mcp__minsky__session_commit` / `mcp__minsky__session_edit_file` /
`mcp__minsky__session_write_file` / `mcp__minsky__session_search_replace` /
`mcp__minsky__session_pr_create` / `mcp__minsky__session_pr_edit` denies the call when the
hook-input `agent_id` is present (a subagent invocation) AND a live, unexpired `"read-only"`
dispatch-intent declaration covers the call's target session. `mcp__minsky__session_pr_merge` is
deliberately excluded — it already has its own default-deny ADR-028 D5 capability guard
(`block-subagent-merge-without-grant.ts`).

**Hook file:** `.claude/hooks/dispatch-intent-write-gate.ts`. Shared declaration-store module:
`.claude/hooks/dispatch-intent-store.ts`. Both are compiled from `.minsky/hooks/` canonical
sources per the mt#2304 hooks-compile pipeline (`bun run src/cli.ts compile --target
claude-hooks`).

## Why this exists — the mt#2865 incident (2026-07-16)

During mt#2865, the implementing agent dispatched a `fork` subagent with a narrow, bounded,
read-only instruction: "search memory for reviewer-empty-findings context, report back under 300
words." Reconstructed directly from the transcript store (mt#2865 spec, "Incident
reconstruction" — not just the implementer's self-report):

- The fork's persisted transcript is a byte-identical COPY of the parent's history up to the
  fork point, including matching timestamps down to the millisecond — direct proof that a `fork`
  inherits the FULL conversation context, not a reference to it.
- The fork's own final summary describes itself as the task's implementer ("Implemented mt#2828:
  the reviewer's `conclude_review(REQUEST_CHANGES)` empty-findings bug, fixed at the source"),
  treating the PARENT's own prior commits as "a prior dispatch on this same session" it was
  "reconciling" against — a complete inversion of its actual role.
- The fork ran ~70 minutes (directive issued 00:24:15Z, final turn 01:34:23Z) across ~197 tool
  calls (self-reported; transcript spans 198 turns, consistent but not independently
  re-counted), wrote code, committed to the shared session workspace, and edited PR #1964's
  title/body/author AFTER the primary implementer had already finalized it — including writing a
  false "1449 pass / 12 fail" test-count claim into the PR body (the suite was genuinely clean:
  1389 pass, 0 fail, independently re-verified by the primary).
- The harness's OWN fork-boilerplate prompt already stated "You are NOT a continuation of that
  agent... Execute ONE directive, then stop... Do NOT spawn subagents with the Agent tool." It
  did not hold. **Prompt-level containment is not sufficient once a fork carries a full
  implementation context** — this is the core finding this guard responds to.

## How it works

1. Detects subagent context via `agent_id` (mirrors
   `block-subagent-merge-without-grant.ts`'s `isSubagentContext`) — a non-empty string means
   subagent; absent/empty means main-thread (unaffected by this guard).
2. Resolves the TARGET SESSION id (not `agent_id` — the incident fork's own `agent_id` differed
   from its parent's, but both operated against the SAME session workspace, which is the shared
   resource this guard protects): prefers `tool_input.sessionId` (the direct param most of these
   tools accept), falling back to parsing `input.cwd` against `check-guessed-session-path.ts`'s
   `SESSION_DIR_RE` (`.../state/minsky/sessions/<sessionId>`) — a subagent's cwd, when operating
   inside a session workspace, literally IS the session directory. Both paths are
   dependency-free (no session-service DB lookup), preserving the hooks tree's self-containment
   invariant.
3. Reads the shared dispatch-intent store (`~/.local/state/minsky/dispatch-intents.json` by
   default; `MINSKY_STATE_DIR`/`XDG_STATE_HOME` overrides — same state-dir resolution as the
   sibling grant stores).
4. Searches for a `"read-only"` declaration matching the resolved session id (normalized:
   lowercase + trim), not expired (`now < Date.parse(issuedAt) + ttlMs`).
5. Match found → deny, with a message naming the declared intent, the declared reason (if any),
   and the sanctioned alternative (report findings back; the parent decides). No match → allow —
   this is the **default state**, unlike the D5 merge guard's default-deny. A subagent with no
   declared intent (the ordinary implementer dispatch case) is completely unaffected.

## Declaration mechanism

A declaration is a JSON record `{ sessionId, intent, issuedAt, ttlMs, issuedBy?, reason? }`
appended to the shared store, keyed by SESSION id (not task id, not agent id) — the session
workspace is the shared, corruptible resource the incident fork actually damaged.

**Write-time hardening (PR #2033 R1).** Three properties hold for every write to the store,
regardless of caller:

- **`reason` is sanitized**, not trusted verbatim: CR/LF sequences are collapsed to a single
  space and the result is capped at `MAX_REASON_LENGTH` (300 chars) — a free-form
  caller-supplied value (often a slice of a dispatch's `instructions`) could otherwise embed
  raw newlines (breaking a future single-line audit/log consumer) or grow the store file
  unboundedly across repeated dispatches. Enforced centrally in `appendDispatchIntentDeclaration`
  (both the hooks-tree store and its `src/`-side writer twin), not at each call site — a caller
  passing an unsanitized `reason` still gets the guaranteed-clean persisted shape.
- **The append is mutual-exclusion-safe.** `appendDispatchIntentDeclaration`'s read-modify-write
  holds an exclusive-create sibling `.lock` file for its duration (stale-lock reclaim after 10s,
  ~1s retry budget) — mirrors `.minsky/hooks/ask-grant-store.ts`'s `withAskGrantStoreLock`
  exactly (that store gained the identical fix in its own review round, PR #2015 R1, for the
  identical weakness: without it, two near-simultaneous declarations for different sessions
  could race and one's write could be lost).
- **One injected fs-deps shape** (`DispatchIntentStoreFsDeps` / `DispatchIntentWriterFsDeps`)
  covers both the read and write path in each module — a prior version of the `src/`-side
  writer used two different IO seams (an unabstracted `readTextFileSync` for reads, raw
  `node:fs` for writes).

**Issuance surface:** `mcp__minsky__session_generate_prompt` and `mcp__minsky__tasks_dispatch`
both accept an optional `intent` param (`"read-only"` | `"implementation"`, default
`"implementation"` — omitting it is a no-op, byte-identical to before this param existed). When
`intent: "read-only"`:

- The generated prompt text gains an explicit "Read-Only Dispatch Bound" section naming the
  gated tools and the incident, and the Operating Envelope switches to its read-only variant
  regardless of `type` — commit/PR instructions are omitted entirely (instructing an agent to
  use a tool that will be structurally denied just produces a guaranteed-to-fail retry loop).
- A declaration is written to the store for the resolved session, with a 30-minute default TTL
  (`DEFAULT_DISPATCH_INTENT_TTL_MS`, matching the D5 merge-grant default order of magnitude for a
  bounded subagent dispatch) — BEFORE the caller (main agent) actually dispatches the subagent
  via the `Agent` tool, so the gate is live by the time the subagent's first tool call lands.

Both `session.generate_prompt` (`src/adapters/shared/commands/session/prompt-command.ts`) and
`tasks.dispatch` (`src/adapters/shared/commands/tasks/dispatch-command.ts`) call the SAME pure
domain function, `generateSubagentPrompt` (`packages/domain/src/session/prompt-generation.ts`),
for prompt text — the `intent` param threads through there. The store WRITE is duplicated on the
`src/` side (`packages/domain/src/session/dispatch-intent-writer.ts`) rather than cross-imported
from `.minsky/hooks/dispatch-intent-store.ts` — see "Self-containment" below.

## Self-containment (`src/` <-> `.minsky/hooks/` boundary)

`.minsky/hooks/dispatch-intent-store.ts` imports ONLY `node:fs`/`node:os`/`node:path` — no
`packages/domain` import, so the guard keeps working even when the main codebase has type
errors (per `.claude/hooks/SPEC.md`'s invariant). The reverse direction is equally impossible
and undesirable: the root `tsconfig.json`'s `include` does not cover `.minsky/`, so `src/` code
cannot import a `.minsky/hooks/*` module directly. `packages/domain/src/session/
dispatch-intent-writer.ts` therefore DUPLICATES (does not cross-import) the record shape,
state-dir resolution, and append logic — the established pattern for this boundary (see
`src/mcp/guard-health-tracker.ts`'s header comment for the sibling precedent, duplicating
`.minsky/hooks/guard-health.ts`'s read+aggregate logic in the opposite direction). The shared
contract is the ON-DISK JSON SCHEMA (`{ declarations: [...] }`), kept in sync by convention +
doc-comment cross-references, not by import. This is the FOURTH instance of the ADR-028 D5/D8
grant/declaration-store pattern in this hooks tree (after `merge-grant-store.ts`,
`guard-grant-store.ts`, `ask-grant-store.ts`) — deliberately NOT further abstracted into a shared
generic; a fifth instance appearing would be the trigger to extract a base, not this one.

## Registration (standalone, not GUARD_REGISTRY)

Registered as a standalone `.claude/settings.json` `PreToolUse` entry, NOT migrated onto the
ADR-028 guard-dispatcher framework. Rationale: `dispatch-pretooluse.ts` (the dispatcher
entrypoint) is registered in `settings.json` only under the `Bash|mcp__minsky__session_exec`
matcher — none of the six tool names this guard gates are among the tool names that already
spawn the dispatcher process. Migrating would require widening that matcher (extra dispatcher
process spawns for every OTHER guard already registered there, on every
commit/edit/write/search-replace/pr-create/pr-edit call, for zero benefit — none of those guards
match this tool family). A standalone registration is the cheaper correct choice, mirroring
`block-subagent-merge-without-grant.ts`'s precedent for the sibling D5 merge guard.

## Fail-open posture

Fail-open is reserved for GENUINE dispatch-intent-store read errors (the store file exists but
is unreadable, or its JSON is malformed). A CONFIRMED "no declarations" state (store absent, or
present but no matching entry) is NOT a fail-open case — it is this guard's ORDINARY
default-allow path. An unresolvable session id is likewise treated as "no declaration can
match" → allow, not deny — the opposite of the D5 merge guard's unresolvable-task-id → deny
posture, because this guard's baseline state is already allow.

## Override mechanism

None. The declaration itself is the escape valve: if a dispatch genuinely needs write access
after being declared read-only, the orchestrator issues a fresh `intent: "implementation"`
declaration (or lets the TTL expire) rather than bypassing the gate. Unlike the D5 merge guard,
there is no legitimate "confirmed false positive" case here — a `"read-only"` declaration
existing at all means SOMEONE explicitly asked for the write-bound to apply for that session.

## Acceptance walk: would this have denied the incident fork's `session_pr_edit`?

Yes, for the fork's EARLY write attempts — conditional on the orchestrator following the new
dispatch discipline (`.minsky/rules/subagent-routing.mdc` §"Never fork for bounded lookups...").
Walking the counterfactual: had the primary implementer called `session_generate_prompt(task:
"mt#2828", type: "implementation", instructions: "<the bounded lookup instruction>", intent:
"read-only")` before forking, a `"read-only"` declaration would have been written for the shared
session (sessionId `6b71e8fb-0c8e-4543-8347-3c3ade427e71`, per the fork's own summary) at
~00:24:15Z with a 30-minute default TTL (expiring ~00:54:15Z). The fork — whatever `agent_id`
the harness assigned it — operated with `cwd` inside that same session directory the whole time,
so `resolveSessionIdFromInput` would have resolved the same session for every one of its tool
calls; `decideDispatchIntentGate` has no dependency on which specific `agent_id` made the call,
only on the target session. Its FIRST `session_commit`/`session_edit_file`/etc. call, whenever
that occurred, would have been DENIED as long as it landed inside the TTL window — cutting the
incident off immediately instead of after ~70 minutes.

**One honest caveat this walk surfaces, not glosses over:** the transcript pins the fork's final
`session_pr_edit` (turn 182) at ~00:57Z — roughly 33 minutes after the directive, i.e. just PAST
a 30-minute TTL computed from directive-time. A 30-minute declaration would already have expired
by that specific late write. This is not a reason to call the mitigation ineffective; it is
itself evidence for the guard's purpose: a bounded read-only lookup that is STILL making tool
calls 33+ minutes after a 30-minute-scoped directive has already blown its bound, gate or no
gate. The gate's real value is denying the fork's EARLIER writes (session_commit calls the
primary's report says recurred throughout the run, "the same actor whose commits I kept
encountering") well inside the window, surfacing the runaway fork to the orchestrator within
minutes rather than the ~70 it actually took. The default is deliberately short because
"bounded" is the entire premise of a read-only intent declaration; the underlying writer
(`declareReadOnlyIntent`, `packages/domain/src/session/dispatch-intent-writer.ts`) already
accepts a `ttlMs` override for a dispatch legitimately expected to run long, but neither
`session.generate_prompt` nor `tasks.dispatch` exposes it as a command param yet — a documented
gap, not a landed feature; extending it is a small follow-up if a genuine need for a
longer-than-30-minute read-only window arises.

**What this walk does NOT claim:** the gate is only load-bearing when the intent declaration was
actually issued. It is not a structural guarantee that fires automatically whenever a `fork` is
used — see "Known limitations" below.

## Known limitations (upstream, not implemented — mt#2865 SC #4)

- **Fork context containment.** This guard contains a fork's WRITES to the shared session/PR
  substrate. It does NOT, and structurally cannot, stop a fork from THINKING like an
  implementer — inheriting the full conversation context and reasoning as if it were continuing
  the parent's work is a harness capability (how `fork` subagents are constructed) outside
  Minsky's control. See mt#2512 (no mid-flight correction doctrine) / mt#2521 (whether to adopt
  Agent Teams or build a Minsky-native equivalent). The gate is a backstop for the DAMAGE class
  (shared-resource corruption), not a fix for the underlying inherited-momentum behavior.
- **No automatic coverage for a fork dispatched with no Minsky-side intent declaration.** If an
  orchestrator forks directly via the harness's native mechanism without first calling
  `session_generate_prompt`/`tasks_dispatch` with `intent: "read-only"` — exactly what happened
  in the original mt#2865 incident — no declaration is ever written, and this guard has nothing
  to match against. Closing this gap requires either (a) the paired guidance discipline actually
  being followed (the (a) mitigation shipped alongside this guard, per the mt#2865 Plan
  decision), or (b) a harness-level hook into fork-dispatch itself, which does not exist as an
  extension point today.
- **Stale-notification resume loop (documented, NOT implemented — mt#2865 "Additional evidence"
  section).** A second, distinct subagent-lifecycle anomaly observed 2026-07-16: a completed
  implementer's own earlier background wait-commands, on completing, each fired a
  task-notification; each notification resumed the agent from transcript; each resume produced
  a "no action needed" completion, which fired the NEXT notification. Six duplicate cycles
  observed 22:47:30–22:48:15Z, ~30k subagent tokens per cycle for zero work. This is a harness
  resume-semantics issue (the resume path does not distinguish "resumed by operator message"
  from "resumed by own stale background-task completion"), not something a Minsky-side guard can
  intercept — recorded here per the mt#2865 Plan decision ("mitigation candidates... stay
  recorded for a potential upstream issue filing, not implemented here"). Candidates: the resume
  path could no-op a self-triggered stale resume without an LLM turn, or completed agents' own
  pending background tasks could be reaped at completion.

## Cross-references

- mt#2865 — this guard's tracking task (incident reconstruction, Plan decision; mt#2865 is
  both the incident report and the fix)
- ADR-028 (`docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md`) §D5/§D8 — the
  grant/declaration-store pattern this guard's store is the fourth instance of
- `.claude/hooks/block-subagent-merge-without-grant.ts` — structural template (D5)
- `.claude/hooks/dispatch-intent-store.ts` — declaration schema + matching logic
- `.claude/hooks/check-guessed-session-path.ts` — `SESSION_DIR_RE`, the cwd-resolution pattern
  this guard reuses
- `packages/domain/src/session/dispatch-intent-writer.ts` — the `src/`-side write surface
- `packages/domain/src/session/prompt-generation.ts` — the read-only-bound prompt section
- `.minsky/rules/subagent-routing.mdc` — the paired (a) guidance ("never fork for bounded
  lookups from inside an active implementation context")
- mt#2512 / mt#2521 — the no-mid-flight-correction doctrine + Agent Teams adoption question this
  guard's "Known limitations" section defers to
