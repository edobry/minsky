# Guard-Dispatcher Framework (ADR-028 Phase 1–2b)

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A shared in-process framework (`.minsky/hooks/registry.ts` + `.minsky/hooks/dispatcher.ts` +
per-event entrypoints like `.minsky/hooks/dispatch-pretooluse.ts` and
`.minsky/hooks/dispatch-userpromptsubmit.ts`) that lets multiple guards share ONE spawned Bun
process per lifecycle event instead of each guard being its own `settings.json` registration
and OS process. This is the framework-primitives phase of ADR-028
(`docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md`) — it ships inert alongside
every existing standalone hook file; only guards explicitly migrated (an entry in
`GUARD_REGISTRY`) run through it. As of this section's authoring, SIXTEEN guards have migrated:
`check-guessed-session-path` (the Phase 1 PreToolUse pilot) plus the ENTIRE `UserPromptSubmit`
event — Phase 2a's six-guard guidance-detector family (`substrate-bypass-detector`,
`retrospective-trigger-scanner`, `pre-narration-detector`, `causal-premise-detector`,
`code-mechanism-assertion-detector`, `ask-routing-deferral-detector`) plus Phase 2b's remaining
nine (`auto-session-title`, `inject-current-time`, `inject-git-state`, `inject-prod-state`,
`inject-dispatch-watchdog`, `memory-search`, `skill-staleness-detector`,
`mcp-daemon-staleness-detector`, `calibration-review-cadence-detector`) — see the "Phase 2a
family migration" and "Phase 2b family migration" subsections below. Every other guard
documented elsewhere in this file (PreToolUse siblings, PostToolUse, Stop, etc.) remains a
standalone `settings.json` registration.

**Why this exists.** ADR-028's measured baseline (2026-07-07): 48 `settings.json` hook
registrations across 45 distinct files; a single `UserPromptSubmit` event spawned up to 14
separate Bun processes; `mcp__minsky__session_pr_merge` spawns 4. Each process independently
re-reads `.claude/settings.json` (`readHostCap`), independently parses the transcript
(`resolveTranscriptCandidates`), and independently hand-rolls override-env-var truthy-parsing
and calibration-log appending. `src/hooks/pre-commit.ts` (the husky pre-commit dispatcher) is
the in-repo proof this "one process, many pure-function checks" shape already works in
Minsky; this framework generalizes it to the Claude Code hook family. Post-Phase-2b, the
`UserPromptSubmit` event spawns exactly 1 process (down from 14) — the ADR's full target for
this event — see the Phase 2a and Phase 2b subsections.

**Framework files (all under `.minsky/hooks/`, compiled to `.claude/hooks/` per mt#2304):**

- **`registry.ts`** (D2) — the declarative schema. `GuardRegistration` names a guard's
  `event`, tool-name `matcher` regex, dynamic `module()` import, `timeoutMs`, optional
  `calibrationLog` name, and `denyCapable` flag. `GUARD_REGISTRY` is the single array every
  dispatcher consults. `getGuardsForEvent(registrations, event, toolName)` filters by event
  - matcher (a matcher-less registration always matches once its event matches — the
    non-tool-event case). `findDuplicateRegistrations(registrations)` implements ADR-028
    D7(2)'s registry-completeness lint: two registrations sharing an event and an overlapping
    `|`-delimited matcher token are flagged — a mechanical query replacing the manual
    `settings.json`-scanning that today hides duplication (e.g. the literal string
    `"Edit|Write|NotebookEdit"` appearing verbatim in three separate blocks). Matcher-less
    registrations are flagged against each other ONLY as a genuine overlap risk relative to a
    matchered sibling; two matcher-less registrations on the SAME non-tool-scoped event are NOT
    flagged (Phase 2a, mt#2652) — that's the normal, by-design shape for a family of independent
    guards on an event with no tool name to match against (e.g. the six UserPromptSubmit
    guidance detectors), not an accidental duplicate.
- **`dispatcher.ts`** — the D1/D3/D4/D6 core services:
  - `runDispatcher(event, options)` — the D1 loop: read stdin ONCE, resolve the D6 context
    ONCE, filter `GUARD_REGISTRY` to guards matching `event` + `tool_name`, then for each
    matched guard: check the D3 override (skip + audit-line if overridden), invoke the
    guard's `run()` (catch-and-log-to-stderr on throw — one guard failing never disables the
    rest), and either short-circuit on the first `deny` from a `denyCapable` guard
    (first-deny-wins, now an explicit registry-order property) or accumulate
    `additionalContext` fragments for a single consolidated `HookOutput` at the end. A
    matched-but-silent guard produces no stdout at all, matching every existing guard's
    "write nothing on allow" convention.
  - `checkOverride(guardName, env?)` (D3) — the unified override predicate for
    `MINSKY_HOOK_OVERRIDE=<guard-name>[,<guard-name>...]` (or the literal `all`).
    `buildOverrideAuditLine(event, guardName, sessionId, now?)` emits the shared format
    `[dispatcher:<event>] OVERRIDE: guard=<name> session=<id> ts=<iso>` — a non-JSON stdout
    line Claude Code's hook-output parser ignores, matching the sibling-hook audit
    convention. Migrated guards' OWN legacy override env vars (e.g.
    `MINSKY_SKIP_SESSION_PATH_CHECK`) remain honored independently by the guard's `run()` —
    the Phase 7 deprecation-shim lookup table (legacy-var-name -> guard-name) is explicitly
    NOT built yet.
  - `logCalibrationRecord(calibrationLogName, record, options?)` (D4) — appends one JSONL
    line to `.minsky/<calibrationLogName>-calibration.jsonl`, preserving the EXACT filenames
    `CALIBRATION_LOG_REGISTRY` (`src/domain/calibration/calibration-sweep.ts`) already
    expects (e.g. `"causal-premise"` -> `.minsky/causal-premise-calibration.jsonl`) — no
    changes needed to that registry when a detector guard migrates onto this service.
    Best-effort (swallows fs failures) and fully fs-injectable for tests.
  - `resolveDispatchContext(event, input, options)` (D6) — resolves `hostCapSec` +
    `budgets` (via `readHostCap`/`deriveBudgets` from `./types`) and, when `transcript_path`
    is present, `transcriptCandidates` + merged `transcriptLines` (via
    `resolveTranscriptCandidates`/`parseTranscript` from `./transcript`) — ONCE per
    invocation, before any guard runs. Guards receive this as their `ctx` parameter and
    never call these primitives themselves — this closes the ENTIRE CLASS of "guard reads
    `transcript_path` naively, breaks for background-dispatched subagents" bugs (mt#2637) at
    the framework boundary instead of per-guard.
- **`dispatch-pretooluse.ts`** — the PreToolUse entrypoint (`if (import.meta.main)` calling
  `runDispatcher("PreToolUse", { hookFilename: "dispatch-pretooluse.ts" })`, fail-open on any
  top-level error). The SOLE `settings.json` `PreToolUse` entry for every guard registered
  with `event: "PreToolUse"` in `GUARD_REGISTRY`.
- **`dispatch-userpromptsubmit.ts`** (Phase 2a, mt#2652) — the UserPromptSubmit sibling
  entrypoint, same shape: `runDispatcher("UserPromptSubmit", { hookFilename:
"dispatch-userpromptsubmit.ts" })`. The SOLE `settings.json` `UserPromptSubmit` entry for
  every guard registered with `event: "UserPromptSubmit"` in `GUARD_REGISTRY`. Sibling
  entrypoints for the remaining five lifecycle events (`dispatch-posttooluse.ts`, etc.) are
  NOT built yet — added when a family on that event migrates.

**Guard-module contract (how a guard migrates).** A migrated guard exports a `run(input:
ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null` pure function alongside its
existing `if (import.meta.main)` standalone entrypoint (kept for direct CLI invocation/
debugging — ADR-028 explicitly defers removing it to Phase 6). `GuardModule.run` is declared
with METHOD SHORTHAND syntax (`run(...)`, not a `run: (...) => ...` property) specifically so
TypeScript's method-parameter bivariance lets both tool-scoped guards (`run(input:
ToolHookInput, ctx)` — a `ClaudeHookInput` subtype, e.g. the Phase 1 pilot) and non-tool-scoped
guards (`run(input: ClaudeHookInput, ctx)` exactly — e.g. every Phase 2a UserPromptSubmit
detector, which carries no `tool_name`/`tool_input`) satisfy the SAME `GuardModule` contract
without a union type or per-event generic parameter (mt#2652; Phase 1's registry.ts comment had
explicitly deferred this generalization to "when that phase lands"). `GuardOutcome` fields:
`deny` (only honored when the guard's registration has `denyCapable: true`),
`additionalContext`, `auditLines` (raw non-JSON stdout lines, e.g. the guard's own
legacy-override audit line), and `calibration` (logged via `logCalibrationRecord` when the
registration names a `calibrationLog`). Returning `null`/`undefined` means "no output" (silent
allow). See `check-guessed-session-path.ts`'s `run()` export for the tool-scoped reference
migration, or `retrospective-trigger-scanner.ts`'s `run()` for a non-tool-scoped,
calibration-logging one.

**Settings.json convention going forward.** ONE dispatcher entry per migrated event+matcher
pair — e.g. the pilot's entry is the `dispatch-pretooluse.ts` command inside the existing
`PreToolUse` block with `matcher: "Bash|mcp__minsky__session_exec"`. **Ordering rule:** when
a SINGLE guard migrates out of a `settings.json` block that has other, not-yet-migrated
siblings, the dispatcher's `hooks[]` entry takes the migrated guard's ORIGINAL array
position (same slot) so first-deny-wins execution order relative to those siblings is
unchanged — a NEW trailing block would silently reorder the pilot after every sibling that
happened to be declared first; when a WHOLE event's guards migrate as a group (a later
phase), ordering moves out of `settings.json` array position entirely and into
`GUARD_REGISTRY`'s array order (D1's explicit registry-order first-deny-wins semantics).
Adding a guard to an ALREADY-migrated event+matcher pair means adding a `GUARD_REGISTRY`
entry — no `settings.json` edit. Adding a guard to a NOT-yet-migrated event+matcher pair
still means a new standalone `settings.json` block (today's convention), until that block's
guards are migrated as a group in a later phase.

**Dispatcher host-cap budget model (R1 fix, mt#2652).** A dispatcher's `settings.json`
`timeout` is the HOST CAP for the whole process, and the dispatcher runs every matched guard
SEQUENTIALLY within that one process — so the entry's timeout must cover the FAMILY'S
worst-case SUM (every migrated guard's budget added together), not any single guard's budget.
Getting this wrong silently caps the family at whichever value was copied from one guard,
starving every guard after the first if the process runs long. Each guard's own
`timeoutMs` field in its `GUARD_REGISTRY` entry documents that guard's individual budget
(declarative today, not yet enforced as a per-guard wall-clock cutoff inside `runDispatcher` —
see the Phase 2a section below); `readHostCap`/`deriveBudgets` (from `./types`, invoked once
by D6's `resolveDispatchContext`) derive the SHARED overall/fetch/git budgets from the
dispatcher entry's host-cap `timeout`, not from any individual guard's `timeoutMs`. When a
family migrates as a group (Phase 2a's UserPromptSubmit six-guard case), size the dispatcher
entry's `timeout` to at least the sum of the guards' PRE-MIGRATION individual timeouts (minus
a modest process-spawn-overhead saving is defensible; guessing a single guard's old value is
not). The Phase 1 PreToolUse pilot's `dispatch-pretooluse.ts` entry (`timeout: 15`) does not
yet have this problem — exactly one guard (`check-guessed-session-path`, `timeoutMs: 5000`) is
registered there today — but future `PreToolUse` family migrations (ADR-028 Phase 5) onto that
SAME entry will need this same sum-sizing check applied before adding guards, not after.

**Pilot migration (mt#2650).** `check-guessed-session-path` (see its own section below) was
migrated onto the dispatcher IN PLACE — its command entry within the `Bash|mcp__minsky__
session_exec` `PreToolUse` block was replaced 1:1 with `dispatch-pretooluse.ts`, at the same
array position, alongside its not-yet-migrated siblings (`block-subagent-bypass-merge`,
`require-checks-on-bypass-merge`, `block-git-gh-cli`, `block-out-of-band-merge`) — per the
ordering rule above. Its own section's "Hook file" / behavioral documentation is otherwise
unchanged — the guard's pure-function logic (`findMissingInToolInput`, `buildDenialReason`)
is identical; only the process-dispatch mechanism changed.

**Phase 2a family migration (mt#2652).** The six UserPromptSubmit guidance detectors
(`substrate-bypass-detector`, `retrospective-trigger-scanner`, `pre-narration-detector`,
`causal-premise-detector`, `code-mechanism-assertion-detector`,
`ask-routing-deferral-detector`) migrated onto `dispatch-userpromptsubmit.ts` as a GROUP — the
first whole-event-family migration since the pilot's single-guard slice. Each guard's `run()`
mirrors its `main()`'s orchestration (override check, transcript-turn extraction, pure
detection, calibration/reminder construction) but reads `ctx.transcriptLines` — resolved ONCE
by the dispatcher's D6 shared context — instead of re-parsing `input.transcript_path` itself;
each guard's pure detection functions (the regex matchers, proximity-scoping, markdown-elision
helpers) are byte-unchanged, and each guard's own `main()` / `if (import.meta.main)` CLI
entrypoint is unchanged and still independently invocable. `causal-premise-detector.ts` and
`code-mechanism-assertion-detector.ts` additionally drop their own `readHostCap`/
`deriveBudgets`/deadline bookkeeping inside `run()` — the dispatcher's D6 context already
resolves the host-cap budget once per invocation, before any guard runs, so there is no
equivalent "before transcript read" checkpoint left inside a per-guard `run()`.

- **Settings.json ordering:** per the ordering rule above, this is a WHOLE-EVENT-family
  migration (not a single guard sharing a slot with not-yet-migrated siblings), so the single
  `dispatch-userpromptsubmit.ts` entry took the FIRST migrated guard's
  (`substrate-bypass-detector`) original array slot in the `UserPromptSubmit` block, preserving
  relative order against the guards that had NOT yet migrated at the time (`auto-session-title`,
  `inject-current-time`, `inject-git-state`, `inject-prod-state`, `memory-search`,
  `skill-staleness-detector`, `mcp-daemon-staleness-detector` before it;
  `calibration-review-cadence-detector` after it — migrated in Phase 2b, mt#2687, see below).
  Ordering among the six migrated guards moved into `GUARD_REGISTRY`'s array order, itself
  preserving the pre-migration `settings.json` relative order.
- **Process-count reduction:** the `UserPromptSubmit` event's `settings.json` command count
  dropped from 14 to 9 (6 individual detector processes collapsed into 1 dispatcher process) —
  measured directly by counting `hooks.UserPromptSubmit[].hooks[]` entries before/after.
- **Dispatcher entry timeout (R1 fix):** the six pre-migration standalone entries summed to
  65s (15+10+10+10+10+10); the dispatcher entry is `timeout: 60` — sized to the family-sum
  model in "Dispatcher host-cap budget model" above, not copied from any single guard's old
  value (an earlier draft of this migration shipped `timeout: 15`, which would have silently
  capped the whole six-guard family at the largest single guard's old budget).
- **`findDuplicateRegistrations`'s matcher-less-pair exemption is event-scoped (R1 fix):** the
  exemption documented in `registry.ts` ("two matcher-less registrations at the same event are
  not flagged") applies ONLY on `NON_TOOL_SCOPED_EVENTS` (`UserPromptSubmit`, `SessionStart`,
  `Stop`, `SubagentStop`, `SessionEnd`). On a tool-scoped event (`PreToolUse`/`PostToolUse`),
  two matcher-less registrations genuinely both match every tool call and are still flagged as
  duplicates — an earlier draft exempted matcher-less pairs on ALL events, which would have
  silently disabled the D7(2) check's core case for future `PreToolUse`/`PostToolUse` family
  migrations.
- **Calibration byte-compatibility:** `logCalibrationRecord` writes to the SAME
  `.minsky/<name>-calibration.jsonl` paths with the SAME record shapes the pre-migration
  hand-rolled `appendCalibrationRecord()` functions wrote — no watermark resets, no
  `CALIBRATION_LOG_REGISTRY` changes needed. Verified end-to-end (dispatcher fires -> guard
  matches -> calibration record written -> `calibration-sweep.ts`'s `runSweep`/
  `parseCalibrationRecord` reads it without error) by `scripts/smoke-dispatch-userpromptsubmit.ts`.
- **`policy-coverage-detector` did NOT migrate** despite being named as one of the "seven
  detectors" in mt#2652's spec — ground-truth inspection of `.claude/settings.json` found it
  registered on `PreToolUse` (matcher
  `Edit|Write|NotebookEdit|mcp__minsky__session_edit_file|...`), not `UserPromptSubmit`. Left
  as an independent PreToolUse registration; recorded as a spec discrepancy rather than
  silently migrated to the wrong event.
- **mt#2263** ("unified matcher consolidation for the regex-scanner family") is ADOPTED at the
  process/scaffold layer by this migration — the six detectors now share ONE process, ONE
  override-checking service (D3), and ONE calibration-logging service (D4), eliminating the
  copy-pasted `main()`/override-parsing/`appendCalibrationRecord()` scaffolds mt#2607 finding
  F2 named. mt#2263's literal framing (a single unified REGEX MATCHER across all six
  detectors' distinct pattern families) is NOT built — each guard's own pure detection
  functions remain separate, byte-unchanged modules. Whether that residual scope still
  warrants a task is left to mt#2263's owning task closeout, not decided here.

**No override mechanism for the framework itself.** `checkOverride`/`runDispatcher` are
tested library code, not a guard — there's nothing to bypass. `MINSKY_HOOK_OVERRIDE` is the
override FOR migrated guards (see above), registered in `HOOK_ONLY_ENV_VARS`.

**Env-var registration:** `MINSKY_HOOK_OVERRIDE` is registered in `HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788).

**Recompile rule (mt#2304).** All framework and guard source files live in `.minsky/hooks/`;
`.claude/hooks/*` is a GENERATED output (banner: "Generated by minsky compile. Do not edit
directly."). After editing ANY `.minsky/hooks/*.ts` file, run
`bun run minsky compile --target claude-hooks` (or `bun run src/cli.ts compile --target
claude-hooks` inside a session) to regenerate `.claude/hooks/*`, and commit sources + generated
outputs together — the pre-commit pipeline's compile-output-staleness check (mt#2304) blocks
the commit otherwise. This RULE file (`hook-files.mdc`) is itself a compiled SOURCE for
`CLAUDE.md` / `AGENTS.md` / `.cursor/rules/hook-files.mdc` — after editing it, run `rules
compile` and verify EACH target regenerated (the no-`--target` invocation does not reliably
regenerate every output; `grep` the new section into `CLAUDE.md` specifically, and run
`--target claude.md` / `--target cursor-rules` explicitly if a target is missing the update).

**Phase 2b family migration (mt#2687).** The remaining nine `UserPromptSubmit` hooks —
`auto-session-title`, `inject-current-time`, `inject-git-state`, `inject-prod-state`,
`inject-dispatch-watchdog`, `memory-search`, `skill-staleness-detector`,
`mcp-daemon-staleness-detector`, `calibration-review-cadence-detector` — migrated onto
`dispatch-userpromptsubmit.ts`, completing the `UserPromptSubmit` event (14 -> 1 spawn). Ground
truth (`.claude/settings.json` before this migration) found NINE standalone entries remaining,
not seven as the ADR's "auto-session-title through mcp-daemon-staleness-detector" span and the
Phase 2a "guards NOT migrated" comment both implied — a second instance of the same
under-counting pattern Phase 2a hit with `policy-coverage-detector` (one gap from that same
off-by-one class; the other because `inject-dispatch-watchdog.ts` was added to the codebase
after the ADR text and the Phase 2a comment were written). Migrating all nine — not just seven —
was required for this task's own acceptance test ("ONE UserPromptSubmit process spawn... where
14 existed pre-ADR") to literally hold.

- **`auto-session-title`'s scalar output required a framework extension.** Every other
  UserPromptSubmit guard's output is `additionalContext` (concatenated across the matched set);
  `auto-session-title` instead sets the session's display title via a `sessionTitle` scalar
  field on `hookSpecificOutput` — a Claude Code extension beyond the documented hook-output
  schema. `GuardOutcome.sessionTitle` (registry.ts) and `HookOutput.hookSpecificOutput.sessionTitle`
  (types.ts) were added; `runDispatcher`'s aggregation now also carries the last non-undefined
  `sessionTitle` from the matched set into the final `HookOutput` (in practice only one guard in
  the family ever sets it, so last-write-wins ordering is moot).
- **`inject-git-state` uses `ctx.budgets.gitTimeoutMs` (D6) instead of re-deriving its own host
  cap.** Pre-migration, `computeGitTimeoutMs()` called `readHostCap("inject-git-state.ts", ...)`
  to find its OWN `settings.json` matcher entry. After migration that entry no longer exists (its
  budget is folded into the dispatcher's), so a standalone `readHostCap` call would silently fall
  back to the 15s default instead of the correctly-derived per-family budget — `run()` uses the
  D6-resolved `ctx.budgets.gitTimeoutMs` instead.
- **Registry order is byte-preserved, not append-order.** `GUARD_REGISTRY`'s UserPromptSubmit
  entries are ordered: the 8 Phase 2b hooks that preceded the Phase 2a dispatcher slot in the
  pre-migration `settings.json` (`auto-session-title` .. `mcp-daemon-staleness-detector`), THEN
  the six Phase 2a detectors (the slot they already occupied), THEN
  `calibration-review-cadence-detector` (which sat after the Phase 2a slot). Since
  `runDispatcher` concatenates `additionalContext` fragments in registry-array order, appending
  the Phase 2b entries after Phase 2a's (the initial, since-corrected implementation) would have
  silently reordered what operators see turn to turn — Success Criterion 3's "byte-preserved
  injection order."
- **Settings.json:** the `UserPromptSubmit` block shrank to the single dispatcher entry, timeout
  resized from 60 (Phase 2a's six-guard family sum) to 115 — the host-cap-SUM model applied
  additively: 60 (Phase 2a, already covering its family) + 55 (Phase 2b's nine guards' individual
  worst-case budgets summed: 5+5+5+5+5+10+5+5+10) = 115.
- **Fixture parity tests** (`.minsky/hooks/dispatch-userpromptsubmit.phase2b-parity.test.ts`)
  prove, per hook, that the dispatcher-path `run()` and the standalone CLI entrypoint produce the
  same output for the same fixture input — override-audit-line parity (timestamp-normalized)
  where the hook has a bespoke override var, functional/silent-path parity otherwise. A separate
  test asserts the exact `GUARD_REGISTRY` UserPromptSubmit name order.

**Deferred to later ADR-028 phases (not this task):** Phase 4 — the merge-gate stack, blocked on
mt#2617; Phase 5 — remaining `PreToolUse` blocks; Phase 6 —
`PostToolUse`/`Stop`/`SubagentStop`/`SessionStart`/`SessionEnd`; the legacy-override-var
deprecation-shim lookup table; generating `settings.json`'s `hooks` block FROM the registry
(today it is still hand-maintained, just with fewer entries per migrated family); removing
guards' standalone `if (import.meta.main)` CLI entrypoints.

**Cross-references:**

- `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` — the full decision
  record (D1–D7), migration plan, and community-practice research this framework implements
- mt#2650 — the framework's tracking task (ADR-028 Phase 1, pilot)
- mt#2652 — this section's Phase 2a family migration (UserPromptSubmit guidance detectors)
- mt#2687 — this section's Phase 2b family migration (remaining UserPromptSubmit hooks;
  completes the event's 14-spawns -> 1 target)
- mt#2618 — parent umbrella (ADR-028 acceptance)
- mt#2263 — regex-scanner-family matcher consolidation; adopted at the process/scaffold layer
  by mt#2652 (see "Phase 2a family migration" above)
- mt#2607 — the audit whose finding F2 (scaffold duplication) motivated this family migration
- mt#2304 — the `.minsky/hooks/` -> `.claude/hooks/` compile pipeline this framework's
  source files depend on
- mt#2637 — the transcript-resolution bug class D6 closes structurally
- mt#2617 — shared PR-fetch layer (`pr-context.ts`) the merge-gate stack migration (Phase 4)
  depends on
- `src/hooks/pre-commit.ts` — the in-repo single-dispatcher precedent this framework
  generalizes
- `.minsky/hooks/types.ts` — `readInput`/`writeOutput`/`readHostCap`/`deriveBudgets`, reused
  by `resolveDispatchContext`
- `.minsky/hooks/transcript.ts` — `resolveTranscriptCandidates`/`parseTranscript`, reused by
  `resolveDispatchContext`
- `scripts/smoke-dispatch-userpromptsubmit.ts` — live end-to-end verification (dispatcher fire
  -> calibration write -> calibration-sweep parse)
- Guessed-Session-Path Guard (below) — the pilot guard's own section
