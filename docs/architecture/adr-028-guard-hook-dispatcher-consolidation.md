# ADR-028: Guard-hook dispatcher consolidation — one process per lifecycle event, declarative registry, unified override, calibration-as-a-service

## Status

Proposed

## Context

### Measured baseline (2026-07-07, `.claude/settings.json`, this session's workspace)

Minsky's Claude Code guard/detector ecosystem has grown hook-by-hook, each new check
authored as an independent `.claude/hooks/<name>.ts` file with its own `#!/usr/bin/env bun`
entrypoint and its own `.claude/settings.json` registration. A structured count of the
current `hooks` block:

| Lifecycle event  | Hook registrations | Distinct hook script files |
| ---------------- | -----------------: | -------------------------: |
| PreToolUse       |                 20 |                         18 |
| SessionStart     |                  1 |                          1 |
| Stop             |                  1 |                          1 |
| SubagentStop     |                  2 |                          2 |
| SessionEnd       |                  1 |                          1 |
| PostToolUse      |                  9 |                          9 |
| UserPromptSubmit |                 14 |                         14 |
| **Total**        |             **48** |                    **45**¹ |

¹ 45 distinct files globally (46 counting each event separately) — `typecheck-on-stop.ts`
is the one file registered under two different events (Stop, SubagentStop).

Every one of these 48 registrations is `"type": "command"` — Claude Code spawns a fresh
`bun <script>.ts` OS process for each, which reads `stdin` independently, does its own
`readHostCap()` (re-reading and re-parsing `.claude/settings.json` from disk), and writes
its own `stdout` JSON envelope. **On a single `UserPromptSubmit` event, 14 separate Bun
processes spawn** — `auto-session-title`, `inject-current-time`, `inject-git-state`,
`inject-prod-state`, `memory-search`, `skill-staleness-detector`,
`mcp-daemon-staleness-detector`, `substrate-bypass-detector`, `retrospective-trigger-scanner`,
`pre-narration-detector`, `causal-premise-detector`, `code-mechanism-assertion-detector`,
`ask-routing-deferral-detector`, `calibration-review-cadence-detector`. Their configured
`timeout` values sum to **115 seconds** — the worst-case cumulative budget if execution ever
serializes or backpressures (the mt#2618 spec's "13 spawns / 105s" figure predates the 14th
hook, `calibration-review-cadence-detector`, landing; the number has grown monotonically with
every new detector). A single `mcp__minsky__session_pr_merge` call triggers 4 PreToolUse
hooks whose timeouts sum to **150 seconds**, several of which independently call `gh pr list`
/ `gh api` for overlapping PR data — the exact redundancy mt#2617 (shared PR-fetch) exists to
remove.

Anthropic's own hooks documentation states matched hooks within one matcher run in parallel
("All matching hooks run in parallel, and identical handlers are deduplicated automatically" —
code.claude.com/docs/en/hooks), which would bound wall-clock latency below the naive sum in
the common case. This ADR does not claim to have measured Minsky's own wall-clock hook
latency — no such measurement exists yet — so the 115s/150s figures above are presented as
**configured worst-case budgets**, not observed timings. What IS measured and is independent
of parallelism is the **process-count and scaffold-duplication cost**: 14 (or up to 20)
concurrent process spawns per event still pay OS-level fork/exec + Bun-runtime-startup
overhead 14–20 times, and — more importantly — the maintenance burden below is orthogonal to
whether execution is parallel or sequential.

### The in-repo counter-example already exists

`src/hooks/pre-commit.ts` (1844 lines) is a **single dispatcher process** — `bun run
precommit`, invoked once by husky — that imports 9+ independent pure-function checks
(`detectNulByteViolations`, `discoverProtectedDockerfiles`, `detectMissingJournalEntries`,
`runDeployDomainCheck`, `detectImmutableMigrationViolations`, plus formatting/lint/typecheck
steps) and runs them as sequential steps inside one `PreCommitHook.run()` method, short-
circuiting on the first failure. Each check is a plain exported function tested independently
(`src/hooks/*-detector.test.ts`) with **zero process-spawn cost per check** — the dispatcher
pays one Bun startup, not N. This is proof the pattern works in Minsky's own codebase; the
Claude Code hook family simply never adopted it.

### Scaffold duplication in the detector family

The ~7 `UserPromptSubmit` "guidance" detectors (`substrate-bypass-detector`,
`retrospective-trigger-scanner`, `pre-narration-detector`, `causal-premise-detector`,
`code-mechanism-assertion-detector`, `ask-routing-deferral-detector`,
`calibration-review-cadence-detector`) each hand-roll a near-identical `main()`: read
`readHostCap()` + `deriveBudgets()`, check an override env var via bespoke inline
truthy-parsing, `readInput<ClaudeHookInput>()`, parse the transcript, extract the last turn,
run the detector, `appendCalibrationRecord()` to its own bespoke `.minsky/<name>-
calibration.jsonl`, and conditionally emit `additionalContext`. `causal-premise-detector.ts`
alone spends ~70 of its 440 lines on this scaffold — logic that is byte-identical in shape
across all 7 files. Even `src/hooks/pre-commit.ts`'s already-consolidated checks re-derive
this cost independently: `nul-byte-detector.ts`, `deploy-domain-detector.ts`, and
`immutable-migration-detector.ts` each export their own separately-named
`isOverrideTruthy` / `isDeployDomainOverrideTruthy` / `isImmutableMigrationOverrideTruthy`
function performing the identical `val === "1" || val === "true" || val === "yes"` check.
Consolidation into one process does not by itself eliminate this — the scaffold problem and
the process-fan-out problem are two axes of the same root cause (no shared framework) and
this ADR fixes both.

### Override-var sprawl (34 vars, three sources)

A structured grep across `.claude/hooks/*.ts` (27 vars), `src/hooks/*.ts` (7 vars, 3
overlapping with the harness-hook set), and the `HOOK_ONLY_ENV_VARS` registry in
`packages/domain/src/configuration/sources/environment.ts` (3 additional vars registered for
non-hook, domain-level guards outside both directories) totals **34 distinct
`MINSKY_SKIP_*`/`MINSKY_ACK_*`/`MINSKY_FORCE_*` env vars** — matching the count in this task's
originating spec. Each is independently registered (per the mt#1788
`custom/no-unregistered-minsky-env-var` ESLint rule), independently parsed, and independently
audit-logged with a slightly different message format. 27 of the 34 belong to the Claude Code
harness-hook family this ADR targets directly; 7 belong to the already-consolidated
`src/hooks/pre-commit.ts` dispatcher (3 shared with the harness set) and stand to gain from
Decision 3 below even without a process-model change; 3 belong to domain-level (non-hook)
guards and are out of scope for this ADR's migration but can adopt the same shared primitive
later.

### Three unresolved gaps folded into this task (2026-07-07 scope addition)

During the mt#2607 burndown (18 tasks merged same-day via parallel implementer-subagent
dispatch), two dispatched subagents (mt#2612 → PR #1792, mt#2615 → PR #1795) executed
`session_pr_merge` despite explicit no-merge instructions in their dispatch prompts. Both
outcomes were sound (reviewer-`APPROVE`, CI green) — but the _mechanism_ that would have
prevented an unsound one doesn't exist: `.claude/hooks/block-subagent-bypass-merge.ts`
matches only `Bash` / `mcp__minsky__session_exec` commands containing `gh api PUT
.../pulls/N/merge` — it does not match `mcp__minsky__session_pr_merge` at all (verified: no
`PreToolUse` matcher entry in `.claude/settings.json` targets `session_pr_merge` with an
`agent_id` check; the 4 hooks that DO match `session_pr_merge`
(`require-review-before-merge`, `require-execution-evidence-before-merge`,
`require-deploy-verification-before-merge`, `block-out-of-band-merge`) check PR-review-state
and PR-body content, never the caller's `agent_id`). Instruction-tier compliance ("do NOT
merge the PR" in the dispatch prompt) was the _only_ control, and it failed 2 of 6 times that
session (~33%). Separately, mt#2637 (fixed, PR #1806) found `check-task-spec-read.ts` resolved
the wrong `transcript_path` for background-Agent-dispatched subagents — their hook input's
`transcript_path` points at the _parent_ session's top-level transcript, not their own
per-agent file at `<session>/subagents/agent-<agentId>.jsonl` — producing false-positive
blocks. The fix (`resolveTranscriptCandidates()` in `.claude/hooks/transcript.ts`) is a
one-off patch to one guard; the same naive-transcript-path bug class is latent in every other
guard that reads `transcript_path` directly.

### Composability constraint: the hooks-compile-pipeline redo (mt#2304)

`.claude/hooks/*.ts` are hand-authored today with no Minsky-native canonical source — the one
asymmetry against skills (`.minsky/skills/` → `.claude/skills/`), rules (`.minsky/rules/` →
`.claude/rules/` + `CLAUDE.md`), and agents (`.minsky/agents/` → `.claude/agents/`), all of
which compile via the unified `compile` pipeline (ADR-016 / mt#2280,
`packages/domain/src/compile/`). mt#2304 closes that asymmetry: `.minsky/hooks/` becomes the
canonical source, compiled to `.claude/hooks/` outputs (shebang + `// Generated by minsky
compile` banner + `chmod 0755`), via a new `claude-hooks` compile target mirroring the
existing `claude-skills`/`claude-agents` targets. mt#2304's PR #1562 was closed as stale
2026-07-07 (3-week-old branch, main restructured underneath it by this same burndown); a fresh
implementation on current `main` is imminent, salvaging the reviewed
`packages/domain/src/compile/targets/claude-hooks.ts` compile-target code and
`.minsky/hooks/SPEC.md`. **This ADR's dispatcher/registry design must compose with, not
compete against, that redo** — see Decision 1's "self-contained" constraint and the Migration
Plan's Phase 1 sequencing.

### Adjacent-but-distinct prior art: the mt#1035 detector framework

`packages/domain/src/detectors/` (mt#1035, mt#1543) already defines a `Detector` interface,
`DetectionContext`, and a dismissal store — but it is the **attention-allocation / System 3\***
framework, consumed by the MCP server process itself to route findings into the Asks
subsystem (`signalToAskIntent`). It is architecturally distinct from what this ADR addresses:
Claude Code **harness lifecycle hooks** run as separate OS processes spawned by the Claude
Code client, outside the MCP server's process, and must remain **self-contained with no
imports from `packages/domain/`** (`.claude/hooks/SPEC.md`: "They are self-contained — no
imports from `src/` — so they work even when the main codebase has type errors"). This ADR's
dispatcher framework preserves that invariant — it lives inside the hooks tree
(`.minsky/hooks/framework/` → `.claude/hooks/framework/`), not in `packages/domain/`. A future
convergence between the two "detector" concepts is plausible but explicitly out of scope here.

### Related decisions already made

ADR-024 (Accepted 2026-06-25) decided the **detection-mechanism ladder** (regex → embedding →
learned confirm) for the guidance-hook family — i.e., how a single guard decides _whether it
matched_. This ADR is orthogonal: it decides the **process/dispatch architecture** — how many
OS processes run, how guards are registered, how overrides and calibration logging work. A
guard migrated under this ADR keeps whatever ADR-024 rung it already implements; the migration
changes where the guard's pure-function body executes, not its matching logic.

## Decision

### D1 — One dispatcher process per lifecycle event, guards run in-process

Replace N per-hook process registrations with **one dispatcher script per lifecycle event**
(`dispatch-pretooluse.ts`, `dispatch-posttooluse.ts`, `dispatch-userpromptsubmit.ts`,
`dispatch-sessionstart.ts`, `dispatch-stop.ts`, `dispatch-subagentstop.ts`,
`dispatch-sessionend.ts` — 7 total, one per event Minsky currently uses). Each dispatcher is
the **sole** `.claude/settings.json` entry for its event (collapsing the current 6–7 separate
`PreToolUse` matcher blocks into one), reads `stdin` **once**, resolves shared context once
(host-cap budget, transcript candidates — see D6), loads the declarative registry (D2),
filters registered guards by the incoming `tool_name` (mirroring today's `matcher` regex, now
evaluated in-process instead of by Claude Code's own matcher), and runs each matched guard's
pure function in sequence within the same process — mirroring `PreCommitHook.run()`'s
step-by-step shape.

**Output aggregation** (a concrete implementation constraint surfaced by researching Claude
Code's hook contract): a hook's `stdout` must be exactly one JSON object. For deny-capable
events (`PreToolUse`), the dispatcher **short-circuits on the first `deny`** — preserving
today's implicit "first hook's denial fires first" ordering (documented ad hoc in
`block-subagent-bypass-merge.ts`'s comments), now made an **explicit, declared property of the
registry's guard order** rather than an accident of `settings.json` array position. For
injection-capable events (`UserPromptSubmit`, `PostToolUse`), the dispatcher **concatenates**
every matched guard's `additionalContext` fragment (registry order, one guard's output per
paragraph) into a single consolidated `HookOutput`.

**Self-contained constraint preserved.** The dispatcher and its shared framework services
(D2–D6) live inside the hooks tree — `.minsky/hooks/framework/` (compiled to
`.claude/hooks/framework/` per mt#2304) — never imported from `packages/domain/`. This
preserves the documented invariant that hooks keep working even when the main codebase has
type errors. Individual guard modules remain plain exported functions, unit-testable exactly
as today.

**Async carve-out.** Genuinely fire-and-forget work that must not block the dispatcher's
budget (`transcript-ingest-on-session-end.ts`'s `minsky transcripts ingest` subprocess,
`record-subagent-invocation.ts`'s DB write) stays a detached, `.unref()`'d child process
launched _from_ the dispatcher — the same pattern `emitHookFiredOnDeny()` already uses. This
mirrors the community `claude-mem` project's explicit design choice to keep truly async work
as separate processes (see Community practice, below) — the dispatcher consolidates
_synchronous validation_, not everything.

### D2 — Declarative guard registry

A single manifest, `registry.ts` (or a generated JSON derived from it), maps each guard to:

```ts
interface GuardRegistration {
  name: string; // e.g. "causal-premise-detector" — also the override-check key (D3)
  event: LifecycleEvent; // "PreToolUse" | "PostToolUse" | ... (which dispatcher loads it)
  matcher: string; // tool-name regex, e.g. "Bash|mcp__minsky__session_exec"
  module: () => Promise<GuardModule>; // dynamic import of the pure-function guard
  timeoutMs: number; // per-guard budget within the dispatcher's overall budget
  calibrationLog?: string; // logical name for D4's shared calibration service
  denyCapable: boolean; // participates in first-deny-wins short-circuit (D1)
}
```

The registry is the **single source of truth** that today's copy-pasted `settings.json`
matcher strings approximate by hand (e.g., the literal string `"Edit|Write|NotebookEdit"`
currently appears verbatim in three separate `PreToolUse` blocks with three different guard
sets — a duplication a compiled registry eliminates structurally, since two entries sharing an
`event` + overlapping `matcher` become a single dispatcher-visible group rather than three
independently-typed config blocks). `.claude/settings.json`'s `hooks` key becomes a
**generated** artifact too (7 dispatcher entries, derived from the set of distinct `event`
values in the registry) rather than hand-maintained — a natural but optional extension flagged
here and left to Phase 1 implementation.

### D3 — Unified override mechanism

Replace the 34 bespoke vars with **one**: `MINSKY_HOOK_OVERRIDE=<guard-name>[,<guard-name>...]`
(or the literal `all`). One shared, tested function —

```ts
function checkOverride(guardName: string, env = process.env): OverrideResult;
```

— in the framework parses the var, checks membership, and emits **one** consistent audit-log
line format: `[dispatcher:<event>] OVERRIDE: guard=<name> session=<id> ts=<iso>` (matching the
existing audit-line convention so it stays a non-JSON stdout line Claude Code's hook-output
parser ignores, per the sibling-hook convention already documented in CLAUDE.md). During a
deprecation window, the framework **also** recognizes each legacy var name (a lookup table
mapping `MINSKY_SKIP_CALIBRATION_CADENCE` → `calibration-review-cadence-detector`, etc.) and
emits a one-line "migrate to `MINSKY_HOOK_OVERRIDE=<name>`" deprecation notice on use; legacy
vars are removed once the deprecation window closes (Migration Plan, Phase 6). This directly
reduces the `custom/no-unregistered-minsky-env-var` (mt#1788) registration surface from 34
entries to 1, and — because `checkOverride()` is a framework service, not a per-guard
function — also fixes the redundant-truthy-parser problem inside the already-consolidated
`src/hooks/pre-commit.ts` (D3 has payoff independent of the process-model migration).

### D4 — Calibration logging as a framework service

One function, `logCalibrationRecord(guardName: string, record: CalibrationRecord)`, replaces
the 6 independently hand-rolled `appendCalibrationRecord()` implementations. Records land in a
**shared schema** — `{ timestamp, session_id, guard, matched, matchedPhrases?,
hadSameTurnVerification?, ...guardSpecificPayload }` — written to
`.minsky/calibration/<guard-name>.jsonl` (one file per guard, preserving the existing
per-guard file boundary the mt#2619 `calibration-review-cadence-detector` /
`CALIBRATION_LOG_REGISTRY` (`src/domain/calibration/calibration-sweep.ts`) already expects) OR
optionally a single `.minsky/calibration.jsonl` with `guard` as a discriminator column — the
Phase 1 implementation task decides based on which shape keeps `CALIBRATION_LOG_REGISTRY`
simplest. Either way, the **schema** becomes shared and the **registration** (which guards log
calibration, and their diversity-signal field) is derivable from D2's registry rather than
hardcoded per-log in `calibration-sweep.ts` as it is today.

### D5 — Subagent merge policy: default-deny with an explicit, auditable capability grant

Of the three options the spec poses — (a) blanket `agent_id`-non-empty deny, (b) unconditional
allow when review+CI are green, (c) a per-dispatch capability flag — **this ADR decides (c),
default-deny**, not a reflexive (a):

- **Default (no grant): deny.** A `PreToolUse` guard on `mcp__minsky__session_pr_merge`
  (structurally identical in shape to `block-subagent-bypass-merge.ts`) denies when
  `agent_id` is present AND no live capability grant matches. This preserves the _already-
  documented_ policy (`/implement-task` §9 "Subagent carve-out": subagents stop at PR
  creation; the main agent drives convergence) as a **structural** guarantee instead of an
  instruction-only one — closing the exact gap the 2-of-6 failures exposed.
- **Escape valve: an explicit, TTL-bound capability grant.** A lightweight MCP tool call
  (Phase 3 implementation detail: either a new `session_dispatch_authorize_merge` tool, or an
  option folded into `session_generate_prompt`) that the **dispatching** agent — main, or an
  orchestrating parent coordinating a burndown-style wave — calls explicitly when it wants to
  delegate the full cycle, including merge, to a subagent. The grant is scoped to
  `(parentSessionId, taskId)`, short TTL (on the order of a typical subagent dispatch
  duration), and single-use-or-expiring — an auditable _fact_ set at dispatch time, not an
  instruction the subagent has to remember to comply with.
- **Why not (b) unconditional allow:** the observed 2 cases being sound (reviewer-`APPROVE`,
  CI green) does not generalize to _every_ subagent-driven merge being safe — a subagent can
  misread a bot's `COMMENT`-vs-`APPROVE` distinction, or merge unaware of a parallel-work
  collision an orchestrator watching in aggregate would have caught (the exact class
  `parallel-work-guard.ts` exists to catch, at `session_start`/`tasks_create` time — merge
  time has no equivalent check today). Blanket allow removes the one checkpoint before an
  **irreversible** action: merge auto-sets the task to DONE (per the mt#2511/mt#2515
  task-hijack-guard family's explicit framing, "auto-DONE is irreversible").
- **Why not reflexive (a) with no escape valve:** it would regress the exact throughput the
  mt#2607 burndown demonstrated — 18 tasks merged same-day via parallel implementer dispatch —
  by funneling every merge back through the main agent's own bounded tool budget, making the
  orchestrator a serialization bottleneck for work it had already scoped as independent and
  low-risk. (c)'s grant is strictly _safer_ than (b) — nothing about it weakens
  `require-review-before-merge.ts`'s review/CI gates, it only changes who is permitted to be
  the caller — while preserving (b)'s throughput motivation as an opt-in, not a default.

This guard is **independent of the D1–D4 dispatcher migration** and does not need to wait for
it — see Migration Plan Phase 3.

### D6 — Framework-level input plumbing: transcript resolution at the dispatcher boundary

Institutionalize the mt#2637 fix (`resolveTranscriptCandidates()` in
`.claude/hooks/transcript.ts`, shipped PR #1806) as a **framework guarantee**, not a per-guard
opt-in. The dispatcher resolves the full set of transcript candidates **once**, before
invoking any guard — using `resolveTranscriptCandidates(transcript_path, agent_id)` to cover
both the main-thread case and the background-subagent case (parent transcript +
`subagents/agent-<id>.jsonl` + every sibling `agent-*.jsonl`, tree semantics) — and passes the
resolved, already-parsed transcript lines to every registered guard that declares a
`needsTranscript: true` capability in its registration. Individual guard pure functions
**never call `resolveTranscriptCandidates()` (or `readHostCap()`, or `readInput()`)
themselves** — they receive already-resolved inputs as function parameters. This closes the
entire **class** of "guard written against `transcript_path` naively, breaks for
background-dispatched subagents" bugs at the framework boundary, rather than requiring each of
the ~14 `UserPromptSubmit`-plus-`check-task-spec-read` guards to remember to call the helper
correctly (mt#2637 was one instance; the bug class was latent in every other transcript-reading
guard until this ADR's dispatcher lands). The same principle extends to `readHostCap()` — today
each of 14 processes independently re-reads and re-parses `.claude/settings.json`; the
dispatcher reads it once per event and derives per-guard sub-budgets from `deriveBudgets()`.

### D7 — Acceptance criteria: when does a new hook (hook #88) get justified?

The registry collapses the marginal cost of a new check from "~150 lines of scaffold + 1
spawned process + 1 new env var" to "register a pure function + a matcher pattern," which
inverts today's implicit (and often-skipped) cost-benefit hesitation. The bar shifts from
_"is this worth a whole new process"_ to:

1. **Pure-function-expressible.** The check must be expressible as `(resolvedContext) =>
HookOutput`-shaped result, with no bespoke process-level side effects beyond what the
   dispatcher framework already provides (override checking, calibration logging, transcript
   resolution). A check needing genuine async/background work belongs in the D1 async
   carve-out, not a synchronous guard.
2. **Duplicate-registration check.** Two registry entries with overlapping `event` + `matcher`
   should be flagged (a registry-completeness lint, Phase 1 deliverable) — today's copy-pasted
   matcher strings hide this; a declarative registry makes "does an existing guard already
   cover this surface" a mechanical query instead of a manual `settings.json` scan.
3. **Corpus/skill tier tried first, unless severity justifies skipping it.** Per CLAUDE.md's
   existing escalation ladder ("Process corrections require structural fixes": memory → corpus
   rule → skill → hook), a new **deny-capable** guard should cite either (a) a corpus-rule/skill
   that already failed to prevent the pattern at least once, or (b) severity high enough to
   skip the ladder (data loss, irreversible action, security). This bar is unchanged by this
   ADR — the registry lowers _infrastructure_ cost, not the bar for _when blocking is
   warranted_.
4. **Coverage-receipt gate for deny-capable guards** (already established by ADR-024): at
   least one calibration-log entry with `source: "live"` within 7 days of shipping, or the
   guard is flagged for review. Injection-only (`additionalContext`-only) guards have a lower
   bar since their failure mode (an unwanted reminder) is bounded and cheap.
5. **Not justified when:** the check duplicates an existing guard's matcher+event (extend
   instead of adding); it needs unbounded-latency network I/O inside a synchronous dispatcher
   budget (route to the git-state/prod-state precedent instead — cache + periodic sweep,
   splitting the expensive read out of the per-turn hot path); or it re-derives context the
   dispatcher already resolves (transcript, host-cap budget, override state) instead of
   receiving it as a parameter.

"Hook #88" is justified exactly when it clears (1)–(4) above and is NOT excluded by (5) — the
registry entry itself, reviewed against a lint for schema completeness, is the actual gate;
"a new `.ts` file plus a new `settings.json` block plus a new env var" stops being a unit of
friction that makes people hesitate (correctly or not) to add a check.

## Consequences

**Easier:**

- `UserPromptSubmit` drops from 14 spawned processes to 1; `mcp__minsky__session_pr_merge`
  drops from 4 to 1 (further simplified once mt#2617's shared PR-fetch lands underneath it).
- New guards cost a registry entry, not a new file + settings.json edit + new env var.
- One `checkOverride()` / `logCalibrationRecord()` implementation instead of 34 vars and 6+
  hand-rolled calibration writers; `custom/no-unregistered-minsky-env-var`'s registration
  surface shrinks by ~33 entries.
- Guard-ordering semantics (first-deny-wins) become an explicit, testable registry property
  instead of an implicit `settings.json` array-order accident.
- The mt#2637 transcript-resolution bug class is closed structurally for every current and
  future transcript-reading guard, not patched per-instance.
- Subagent merge policy becomes a structural, auditable grant instead of an instruction the
  subagent can (and twice did) ignore.
- `settings.json`'s copy-pasted matcher strings (e.g. `"Edit|Write|NotebookEdit"` duplicated
  across 3 blocks) become a derived artifact instead of 3 independently-hand-maintained facts.

**Harder / new costs:**

- The dispatcher is a bigger blast radius than a single hook — a bug in the dispatcher's
  matcher-filtering or output-aggregation logic can silently disable every guard on an event,
  where today a broken hook file fails independently. Mitigated by the deny-capable guards'
  coverage-receipt gate and by migrating the **lowest-risk** event first (Migration Plan).
- Guard modules lose their independent `if (import.meta.main)` CLI-invocability once fully
  migrated (Phase 6) — debugging a single guard in isolation requires either keeping a thin
  dev-only CLI wrapper or invoking it through a small in-repo test harness. A CLI wrapper is a
  cheap, explicit Phase 6 deliverable if this friction proves real in practice.
- The registry is a new artifact that must itself compile correctly (mt#2304 dependency) —
  Phase 1 cannot land independently of a working `.minsky/hooks/` → `.claude/hooks/` compile
  target for at least the dispatcher + framework files, even if individual guard migration is
  deferred.
- The unified override var (`MINSKY_HOOK_OVERRIDE=<name>`) is less discoverable via grep for a
  single guard's exact override string than today's per-guard var name — mitigated by keeping
  the legacy-var deprecation shim (with a warning pointing at the new form) through the full
  migration window rather than a hard cutover.

## Migration plan

Sequenced per the spec's explicit guidance: **detector family first** (adopts mt#2263/ADR-024's
existing shared-mechanism precedent; lowest blast radius, all injection-only); **merge-gate
stack after mt#2617 lands** (shared PR-fetch changes those hooks' internal shape anyway — land
that refactor first on the current architecture, then migrate the simplified result).

- **Phase 0 (this ADR).** Decision only. No code.
- **Phase 1 — Framework primitives.** Build the dispatcher core, registry schema + loader,
  `checkOverride()`, `logCalibrationRecord()`, and the D6 transcript/host-cap resolution-at-
  boundary, self-contained under `.minsky/hooks/framework/` (compiled via mt#2304's
  `claude-hooks` target). Ships inert alongside the existing per-hook files — no behavior
  change yet. **Depends on mt#2304's redo landing first** (or lands directly at
  `.claude/hooks/framework/` and gets folded into `.minsky/hooks/` when mt#2304 merges, per
  operator sequencing preference at implementation time).
- **Phase 2 — Migrate all 14 `UserPromptSubmit` hooks onto one dispatcher.** Two sub-waves:
  (2a) the 7 guidance detectors (`substrate-bypass-detector` through
  `calibration-review-cadence-detector`) — highest scaffold-duplication payoff, all
  injection-only (lowest risk); (2b) the remaining 7 (`auto-session-title` through
  `mcp-daemon-staleness-detector`). Target: 14 spawns → 1. Chosen first because this event
  fires on _every turn_ (highest volume) and carries zero deny-capable guards today (lowest
  blast radius for a dispatcher bug).
- **Phase 3 — Subagent merge-policy structural gate (D5).** Independent of the dispatcher
  migration; can land in parallel with Phase 1/2. Implements the capability-grant mechanism
  and the `session_pr_merge` `PreToolUse` check. High priority given the observed 33% failure
  rate of instruction-only enforcement.
- **Phase 4 — Migrate the `session_pr_merge` merge-gate stack** (`require-review-before-merge`,
  `require-execution-evidence-before-merge`, `require-deploy-verification-before-merge`,
  `block-out-of-band-merge`) onto the dispatcher. **Blocked on mt#2617** landing first — these
  are deny-capable and share redundant PR-data fetches; refactor the fetch on the current
  architecture, verify correctness, then migrate the simplified guards.
- **Phase 5 — Migrate the remaining `PreToolUse` blocks**: the `Bash`/`session_exec`
  bypass-merge family (5 guards), the `Edit`/`Write`/`session_*` write-guard families (2
  overlapping blocks), `session_start`/`tasks_create` (`parallel-work-guard`,
  `check-task-spec-read`), `tasks_status_set` (`tasks-status-set-guard`,
  `check-task-spec-read`), `session_commit`/`pr_create`/`pr_edit`
  (`check-branch-fresh`), and the `github__*`-PR-write ban.
- **Phase 6 — Migrate `PostToolUse`, `Stop`/`SubagentStop`, `SessionStart`, `SessionEnd`**
  (fewer entries each; lower urgency; opportunistic alongside sibling work).
- **Phase 7 — Retirement.** Remove the legacy override vars after the deprecation window;
  regenerate `.claude/settings.json`'s `hooks` block as a compile output derived from the
  registry; remove standalone `if (import.meta.main)` entrypoints from fully-migrated guard
  modules (keep a thin dev CLI wrapper if Phase-6 debugging friction proves real); audit every
  remaining transcript-reading guard for D6 compliance (close the mt#2637 bug class
  completely, not just the one instance already fixed).

## Community practice (gate (l))

Researched: Python `pre-commit` (`.pre-commit-config.yaml`), husky + lint-staged, Claude Code
hook frameworks/power-user projects, and general plugin-registry precedent (ESLint).

- **Match.** ESLint's architecture — one AST parse per file, all enabled rules run as
  registered listeners in a **single process** per file, not one process per rule
  (eslint.org/docs/latest/contribute/architecture) — is the dominant "declarative registry
  (name → check function), one process, many checks" shape in mainstream JS tooling and is a
  direct structural match for this ADR's D1+D2. More specifically for Claude Code: the Elixir
  `claude` hex package already ships exactly the proposed shape for Claude Code hooks
  specifically — `mix claude.hooks.run <event>` is a single dispatcher registered in
  `settings.json` that reads a declarative `.claude.exs` config and expands it to full
  commands run in-process (claude.hexdocs.pm/guide-hooks.html) — a real, shipping
  precedent for "declarative registry + single dispatcher per lifecycle event," specifically
  for the tool this ADR targets.
- **Extend.** Neither ESLint nor the Elixir `claude` package needs a compiled-source pipeline
  (mt#2304) or calibration-telemetry-as-a-service (D4) — both are Minsky-specific needs (a
  canonical-source-to-harness-output compile step already used for skills/rules/agents; guards
  that are behavioral _detectors_ emitting FP-calibration data, not pure lint rules). This ADR
  extends the matched pattern with those two Minsky-specific framework services.
- **Deviate.** From Anthropic's own documented default — same-matcher hooks run in parallel,
  each its own process (code.claude.com/docs/en/hooks) — this ADR deliberately deviates,
  consolidating to one process per event regardless of Claude Code's own parallelism, because
  (a) parallelism is scoped to hooks within _one_ matcher block and Minsky's guards are spread
  across 6–7 blocks per event that cannot parallelize against each other under the documented
  model; (b) per-process fork/exec + Bun-startup overhead is paid regardless of wall-clock
  parallelism; (c) Minsky's guards have real ordering semantics (first-deny-wins) that an
  in-process registry can make explicit and testable rather than implicit in array position.
  Cited evidence that the N-process-per-event default has a real, measured cost: a community
  report (ruvnet/ruflo issue #1530) measured 13–16s of added CLI-interaction latency (4.8s
  baseline → 18–21s) attributed to sequential hook process-spawn overhead across 11+ hooks over
  9 lifecycle events — a different project's numbers, not Minsky's own measured latency (which
  this ADR does not claim to have), but a citable existence proof that the failure mode is
  real elsewhere at a comparable hook count. This ADR also preserves one exception the
  research surfaced: the `claude-mem` project deliberately keeps hooks that do genuine
  fire-and-forget async work (crash-isolated, non-blocking) as separate processes rather than
  folding them into a synchronous dispatcher (docs.claude-mem.ai/hooks-architecture) — matching
  this ADR's D1 async carve-out.

## Appendix: draft child-task decomposition (NOT filed — for review after ADR acceptance)

Per the spec's instruction, no `tasks_create` calls were made. The following is a draft
breakdown for review; final task titles/scoping happen at filing time, sequenced against the
Migration Plan phases above.

1. **Guard-dispatcher framework primitives** (Phase 1) — dispatcher core, registry
   schema+loader, `checkOverride()`, `logCalibrationRecord()`, D6 transcript/host-cap
   resolution-at-boundary. Depends on: mt#2304 redo landing (or lands in parallel and folds in).
2. **Migrate `UserPromptSubmit` guidance-detector family onto the dispatcher** (Phase 2a) — 7
   detectors, shared calibration schema. Adopts/closes mt#2263.
3. **Migrate remaining `UserPromptSubmit` hooks onto the dispatcher** (Phase 2b) — 7 hooks,
   completes the highest-volume event (target: 14 → 1 spawn).
4. **Subagent merge-policy structural gate** (Phase 3) — capability-grant mechanism +
   `session_pr_merge` `PreToolUse` check per D5. Independent; can start immediately.
5. **Migrate the `session_pr_merge` merge-gate stack onto the dispatcher** (Phase 4) — 4
   guards. Depends on: mt#2617 (shared PR-fetch) merged first.
6. **Migrate remaining `PreToolUse` blocks onto the dispatcher** (Phase 5) — bypass-merge
   family, write-guard families, `session_start`/`tasks_create`/`tasks_status_set` families,
   `check-branch-fresh`, GitHub-MCP-PR-write ban.
7. **Migrate `PostToolUse`/`Stop`/`SubagentStop`/`SessionStart`/`SessionEnd` onto their
   dispatchers** (Phase 6) — lower urgency, opportunistic.
8. **Retire legacy override vars + generate `settings.json` from the registry** (Phase 7) —
   deprecation-shim removal, registry-derived `settings.json` `hooks` block, remove standalone
   guard entrypoints (or ship a thin dev CLI wrapper if needed).
9. **Audit and close the mt#2637 transcript-resolution bug class across all guards** (folds
   into Phase 2/5/6 as each guard migrates, but tracked as an explicit completeness check
   against every guard that reads `transcript_path`, not just the one instance already fixed).

## Cross-references

- **Depends on / composes with:** mt#2304 (`.minsky/hooks/` → `.claude/hooks/` compile
  pipeline redo — the canonical-source home for the dispatcher, registry, and migrated guard
  modules); ADR-016 (compile pipeline convergence — the pipeline mt#2304 extends).
- **Sequenced after:** mt#2617 (shared PR-fetch across the merge-gate stack — Phase 4
  dependency).
- **Adopts:** mt#2263 / ADR-024 (detection-mechanism ladder for the guidance-hook family — the
  matching-logic layer this ADR's process layer wraps).
- **Originating incidents:** mt#2607 (July 2026 holistic audit — findings F1/F2/F4/F9, the
  "organizational scar tissue" framing); mt#2612 PR #1792 and mt#2615 PR #1795 (subagent
  bypass-merge instances motivating D5); mt#2637 (transcript-resolution bug motivating D6).
- **In-repo precedent:** `src/hooks/pre-commit.ts` (the single-dispatcher, pluggable-pure-
  checks counter-example this ADR generalizes to the Claude Code hook family).
- **Distinct-but-adjacent:** `packages/domain/src/detectors/` (mt#1035/mt#1543 — the
  attention-allocation System 3\* detector framework; explicitly out of scope, see Context).
- **Framework files referenced:** `.claude/hooks/types.ts` (`readHostCap`, `deriveBudgets`,
  `readInput`, `writeOutput`), `.claude/hooks/transcript.ts` (`resolveTranscriptCandidates`,
  `parseTranscript`, `extractLastAssistantTurn`), `.claude/hooks/block-subagent-bypass-
merge.ts` (the D5 structural template), `.claude/hooks/SPEC.md` (behavioral-spec precedent
  for the typecheck/workflow hook subsystems).
