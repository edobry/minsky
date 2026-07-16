// Declarative guard registry — ADR-028 D2.
//
// The registry is the single source of truth that today's copy-pasted
// `.claude/settings.json` matcher strings approximate by hand. Each entry
// maps a guard's pure-function module to the lifecycle event + tool-name
// matcher it runs under, its budget, its calibration-log wiring, and
// whether it participates in first-deny-wins short-circuiting.
//
// This module (and its sibling `dispatcher.ts`) is dependency-free — only
// imports from `./types` and `./transcript`, matching the sibling shared-hook
// module shape (`pr-context.ts`'s "no cross-imports from src/" convention).
// It lives inside the hooks tree so it stays self-contained per
// `.minsky/hooks/SPEC.md`'s invariant: hooks keep working even when the main
// codebase has type errors.
//
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — D1/D2
// @see mt#2650 — this framework's tracking task (ADR-028 Phase 1)
// @see mt#2652 — Phase 2a family migration (UserPromptSubmit guidance detectors)
// @see .minsky/hooks/dispatcher.ts — the core dispatcher loop that consumes this registry
// @see .minsky/hooks/dispatch-pretooluse.ts — the PreToolUse pilot entrypoint
// @see .minsky/hooks/dispatch-userpromptsubmit.ts — the UserPromptSubmit Phase 2a entrypoint

import type { ClaudeHookInput } from "./types";
import type { DerivedBudgets } from "./types";
import type { TranscriptLine } from "./transcript";

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/** The seven Claude Code lifecycle events Minsky's guards currently hook. */
export type LifecycleEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop"
  | "SubagentStop"
  | "SessionEnd";

// ---------------------------------------------------------------------------
// D6 — per-invocation dispatch context (resolved once, passed to every guard)
// ---------------------------------------------------------------------------

/**
 * Shared context the dispatcher resolves ONCE per invocation (D6) and passes
 * to every matched guard's `run()`. Guards never call `readHostCap`,
 * `resolveTranscriptCandidates`, or `readInput` themselves — this closes the
 * entire class of "guard written against `transcript_path` naively, breaks
 * for background-dispatched subagents" bugs (mt#2637) at the framework
 * boundary instead of per-guard.
 *
 * Forward-compat note (Phase 4, NOT this task): the `session_pr_merge`
 * merge-gate stack shares a `pr-context.ts`-fetched `PrContextResult` today
 * via each gate's own call. When that stack migrates onto the dispatcher
 * (ADR-028 Phase 4, blocked on mt#2617), the natural extension is an
 * optional `prContext?: PrContextResult` field here, resolved once by
 * `resolveDispatchContext` behind a registration-level opt-in flag
 * (mirroring `needsTranscript` below) — this interface is a plain object the
 * framework owns, so that extension needs no structural change, only a new
 * field and a new opt-in check. Not built now: doing so would start the
 * Phase 4 migration this task explicitly excludes.
 */
export interface DispatchContext {
  event: LifecycleEvent;
  /** Host-imposed timeout cap (seconds) for the dispatcher process itself. */
  hostCapSec: number;
  /** Derived sub-budgets (overall/fetch/git) from `hostCapSec` — see `deriveBudgets` in `./types`. */
  budgets: DerivedBudgets;
  /**
   * Resolved transcript candidate paths (mt#2637 `resolveTranscriptCandidates`),
   * in scan order. Empty when the invocation carried no `transcript_path`.
   */
  transcriptCandidates: string[];
  /**
   * Every candidate's parsed lines, concatenated in candidate order. Empty
   * when there is no transcript_path. A guard that needs per-candidate
   * short-circuit scanning (rather than a flat merged list) can still walk
   * `transcriptCandidates` itself and re-parse — cheap, since `parseTranscript`
   * is a pure read with no shared state.
   */
  transcriptLines: TranscriptLine[];
}

// ---------------------------------------------------------------------------
// Guard module contract
// ---------------------------------------------------------------------------

/**
 * A guard's outcome for a single dispatch. `null`/`undefined`/`void` means
 * "no output" — the guard neither denies nor wants to contribute context
 * (the historical "exit 0, write nothing" allow path every guard already
 * implements).
 */
export interface GuardOutcome {
  /**
   * Set to deny the tool call. Only honored when the guard's registration
   * has `denyCapable: true` — the dispatcher short-circuits the remaining
   * guards on the first denial (D1's first-deny-wins ordering, now an
   * explicit registry-order property instead of an implicit settings.json
   * array-position accident).
   */
  deny?: { reason: string };
  /**
   * Set to contribute an `additionalContext` fragment. The dispatcher
   * concatenates every matched guard's fragment (registry order, one
   * paragraph per guard) into a single consolidated `HookOutput` (D1).
   */
  additionalContext?: string;
  /**
   * Raw non-JSON line(s) the guard wants written to stdout verbatim — e.g.
   * its own legacy per-guard override audit line (the "legacy vars remain
   * honored by the guards themselves" carve-out; deprecation-shim removal is
   * Phase 7, not this task). Each string should include its own trailing
   * newline.
   */
  auditLines?: string[];
  /**
   * Optional calibration record to log via `logCalibrationRecord` (D4).
   * Requires the guard's registration to declare a `calibrationLog` name;
   * silently ignored otherwise.
   */
  calibration?: Record<string, unknown>;
  /**
   * UserPromptSubmit-only: sets the session's display title. Added for
   * `auto-session-title.ts` (ADR-028 Phase 2b, mt#2687) — the one guard in
   * the family whose output is a scalar session label rather than additive
   * `additionalContext`. Unlike `additionalContext` (concatenated across
   * every matched guard), `sessionTitle` is last-write-wins across the
   * matched set — in practice only one guard in any registered family sets
   * it, so ordering is moot.
   */
  sessionTitle?: string;
}

export type GuardRunResult = GuardOutcome | null | undefined | void;

/**
 * The pure-function contract every dispatcher-migrated guard module exports.
 *
 * Phase 2a generalization (mt#2652): `run`'s input parameter is typed as the
 * BASE `ClaudeHookInput` — the fields every lifecycle event's payload
 * carries (`session_id`, `transcript_path`, `cwd`, `hook_event_name`,
 * `agent_id`). Tool-scoped guards (PreToolUse/PostToolUse) declare their own
 * `run(input: ToolHookInput, ctx)` — a narrower parameter type than the
 * interface's `ClaudeHookInput` — which is permitted because this member is
 * declared with METHOD SHORTHAND syntax (`run(...)`, not `run: (...) => ...`
 * as a property), and TypeScript checks method parameters bivariantly. That
 * lets a single `GuardModule` contract cover both tool-scoped guards
 * (`ToolHookInput`, a `ClaudeHookInput` subtype — e.g.
 * `check-guessed-session-path.ts`) and non-tool-scoped guards
 * (`ClaudeHookInput` exactly — e.g. the UserPromptSubmit guidance-detector
 * family migrated in this phase) without a union type or per-event generic
 * parameter. Phase 1's deferred-generalization note (superseded by this
 * comment) predicted exactly this: "will need to generalize... when that
 * phase lands."
 */
export interface GuardModule {
  run(input: ClaudeHookInput, ctx: DispatchContext): GuardRunResult | Promise<GuardRunResult>;
}

// ---------------------------------------------------------------------------
// Registration schema (D2)
// ---------------------------------------------------------------------------

/**
 * Declarative registration for one guard (ADR-028 D2). The registry is the
 * single source of truth for event, matcher, timeout, and calibration
 * wiring — replacing the copy-pasted `.claude/settings.json` matcher strings
 * (e.g. the literal string `"Edit|Write|NotebookEdit"` appearing verbatim in
 * three separate `PreToolUse` blocks today).
 */
export interface GuardRegistration {
  /** Guard name — also the `MINSKY_HOOK_OVERRIDE` key (D3) and the default calibration-log discriminator. */
  name: string;
  /** Which dispatcher loads this guard. */
  event: LifecycleEvent;
  /**
   * Tool-name regex (PreToolUse/PostToolUse only), tested against
   * `tool_name` via `new RegExp(matcher).test(...)`. Omit for
   * non-tool-scoped events (`UserPromptSubmit`, `SessionStart`, `Stop`,
   * `SubagentStop`, `SessionEnd`) — those always match once the event
   * matches, mirroring today's `matcher`-less settings.json blocks.
   */
  matcher?: string;
  /** Dynamic import of the guard's pure-function module — mirrors D2's `() => Promise<GuardModule>`. */
  module: () => Promise<GuardModule>;
  /** Per-guard budget (ms) within the dispatcher's overall process budget. */
  timeoutMs: number;
  /**
   * Logical calibration-log name (D4) — e.g. `"causal-premise"` maps to
   * `.minsky/causal-premise-calibration.jsonl`, preserving the exact
   * filenames `CALIBRATION_LOG_REGISTRY`
   * (`src/domain/calibration/calibration-sweep.ts`) already expects. Omit
   * for guards that never log calibration records.
   */
  calibrationLog?: string;
  /** Whether this guard participates in first-deny-wins short-circuiting (D1). */
  denyCapable: boolean;
  /**
   * Whether the dispatcher should resolve+parse transcripts before invoking
   * this guard (D6). Guards that don't read transcripts should omit this —
   * the dispatcher still resolves `hostCapSec`/`budgets` unconditionally for
   * every matched guard, but transcript resolution is comparatively more
   * expensive (fs reads across every candidate) and is worth gating.
   */
  needsTranscript?: boolean;
}

// ---------------------------------------------------------------------------
// Registry (Phase 1: one entry — the pilot migration)
// ---------------------------------------------------------------------------

/**
 * Declarative guard registry (D2). Phase 1 (mt#2650) shipped exactly ONE
 * entry — `check-guessed-session-path`, the pilot migration — proving the
 * architecture end-to-end. Family migrations (Phase 2+) append entries here;
 * a straightforward guard migration needs no dispatcher/framework code
 * changes, only a new registration + the guard's own exported `run()`.
 *
 * Phase 2a (mt#2652) adds the six UserPromptSubmit guidance detectors
 * (substrate-bypass, retrospective-trigger, pre-narration, causal-premise,
 * code-mechanism-assertion, ask-routing-deferral). All six are
 * `needsTranscript: true` (D6 resolves `ctx.transcriptLines` once for the
 * whole family instead of each guard re-parsing the transcript itself) and
 * `denyCapable: false` (informational — additionalContext / calibration
 * only, never a permission denial). Order mirrors the pre-migration
 * `.claude/settings.json` UserPromptSubmit block's relative order.
 *
 * NOT migrated in Phase 2a: `policy-coverage-detector`, despite being named
 * as one of the "seven detectors" in mt#2652's spec — ground-truth check of
 * `.claude/settings.json` found it registered on `PreToolUse` (matcher
 * `Edit|Write|NotebookEdit|mcp__minsky__session_edit_file|...`), not
 * `UserPromptSubmit`. Left as an independent PreToolUse registration per the
 * task's scope-precision instruction; recorded as a spec discrepancy.
 *
 * Phase 2b (mt#2687) adds the remaining UserPromptSubmit hooks: the 8 named
 * by the ADR's "auto-session-title through mcp-daemon-staleness-detector"
 * span (`auto-session-title`, `inject-current-time`, `inject-git-state`,
 * `inject-prod-state`, `inject-dispatch-watchdog`, `memory-search`,
 * `skill-staleness-detector`, `mcp-daemon-staleness-detector`) PLUS
 * `calibration-review-cadence-detector` — ground-truth inspection of
 * `.claude/settings.json` found NINE standalone UserPromptSubmit entries
 * remaining, not seven: the ADR text under-counts by one (mirroring Phase
 * 2a's own `policy-coverage-detector` discrepancy), and Phase 2a's own
 * "guards NOT migrated" comment (in `dispatch-userpromptsubmit.ts`, written
 * before `inject-dispatch-watchdog.ts` existed) separately omitted that
 * hook. Migrating all nine is required for this task's own acceptance test
 * ("ONE UserPromptSubmit process spawn... where 14 existed pre-ADR") to
 * literally hold — any leftover standalone hook would mean more than one
 * spawn. None of the nine needs transcript access (`needsTranscript`
 * omitted for all) — none reads `transcript_path`/`ctx.transcriptLines`,
 * unlike the Phase 2a detector family above.
 */
// Registry order for UserPromptSubmit entries below is LOAD-BEARING (Success
// Criterion 3): it must byte-preserve the pre-migration `.claude/settings.json`
// block's relative order — auto-session-title .. mcp-daemon-staleness-detector
// (Phase 2b's 8), THEN the Phase 2a dispatcher's original slot (the six
// guidance detectors, which took `substrate-bypass-detector`'s position when
// Phase 2a folded them in), THEN calibration-review-cadence-detector (which
// sat AFTER the Phase 2a dispatcher slot in settings.json). `runDispatcher`
// concatenates `additionalContext` fragments in registry-array order, so
// resorting this array resorts what operators see.
export const GUARD_REGISTRY: GuardRegistration[] = [
  {
    name: "check-guessed-session-path",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./check-guessed-session-path").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: true,
  },
  // -------------------------------------------------------------------------
  // Phase 2b (mt#2687) — the 8 UserPromptSubmit hooks that preceded the
  // Phase 2a dispatcher slot in the pre-migration settings.json order.
  // -------------------------------------------------------------------------
  {
    name: "auto-session-title",
    event: "UserPromptSubmit",
    module: () => import("./auto-session-title").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "inject-current-time",
    event: "UserPromptSubmit",
    module: () => import("./inject-current-time").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "inject-git-state",
    event: "UserPromptSubmit",
    module: () => import("./inject-git-state").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "inject-prod-state",
    event: "UserPromptSubmit",
    module: () => import("./inject-prod-state").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "inject-dispatch-watchdog",
    event: "UserPromptSubmit",
    module: () => import("./inject-dispatch-watchdog").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "memory-search",
    event: "UserPromptSubmit",
    module: () => import("./memory-search").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    denyCapable: false,
  },
  {
    name: "skill-staleness-detector",
    event: "UserPromptSubmit",
    module: () => import("./skill-staleness-detector").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  {
    name: "mcp-daemon-staleness-detector",
    event: "UserPromptSubmit",
    module: () => import("./mcp-daemon-staleness-detector").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
  },
  // -------------------------------------------------------------------------
  // Phase 2a (mt#2652) — the six guidance detectors, in the Phase 2a
  // dispatcher entry's original settings.json slot.
  // -------------------------------------------------------------------------
  {
    name: "substrate-bypass-detector",
    event: "UserPromptSubmit",
    module: () => import("./substrate-bypass-detector").then((m) => ({ run: m.run })),
    timeoutMs: 15000,
    denyCapable: false,
    needsTranscript: true,
  },
  {
    name: "retrospective-trigger-scanner",
    event: "UserPromptSubmit",
    module: () => import("./retrospective-trigger-scanner").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "retrospective-trigger",
    denyCapable: false,
    needsTranscript: true,
  },
  {
    name: "pre-narration-detector",
    event: "UserPromptSubmit",
    module: () => import("./pre-narration-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "pre-narration",
    denyCapable: false,
    needsTranscript: true,
  },
  {
    name: "causal-premise-detector",
    event: "UserPromptSubmit",
    module: () => import("./causal-premise-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "causal-premise",
    denyCapable: false,
    needsTranscript: true,
  },
  {
    name: "code-mechanism-assertion-detector",
    event: "UserPromptSubmit",
    module: () => import("./code-mechanism-assertion-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "code-mechanism-assertion",
    denyCapable: false,
    needsTranscript: true,
  },
  {
    name: "ask-routing-deferral-detector",
    event: "UserPromptSubmit",
    module: () => import("./ask-routing-deferral-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "ask-routing-deferral",
    denyCapable: false,
    needsTranscript: true,
  },
  // -------------------------------------------------------------------------
  // Phase 2b (mt#2687) — calibration-review-cadence-detector sat AFTER the
  // Phase 2a dispatcher slot in the pre-migration settings.json order.
  // -------------------------------------------------------------------------
  {
    name: "calibration-review-cadence-detector",
    event: "UserPromptSubmit",
    module: () => import("./calibration-review-cadence-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    denyCapable: false,
  },
  // -------------------------------------------------------------------------
  // mt#2824 — silent-stretch heartbeat detector. New guard authored directly
  // onto this framework (not a migrated legacy standalone hook), so it has
  // no bespoke pre-migration settings.json slot to preserve ordering for.
  // Appended at the end of the family; needs transcriptLines (D6) to walk
  // the just-completed turn for tool-only silence.
  // -------------------------------------------------------------------------
  {
    name: "silent-stretch-detector",
    event: "UserPromptSubmit",
    module: () => import("./silent-stretch-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "silent-stretch",
    denyCapable: false,
    needsTranscript: true,
  },
];

// ---------------------------------------------------------------------------
// Matcher filtering
// ---------------------------------------------------------------------------

/**
 * Filter `registrations` to guards matching `event` and (for tool-scoped
 * registrations) `toolName`. A registration with no `matcher` always matches
 * once its `event` matches. A registration WITH a `matcher` but no `toolName`
 * supplied (the non-tool-event dispatch case) does not match — matchers are
 * meaningless without a tool name to test. Malformed matcher regex is
 * treated as non-matching (fail-open — a bad regex must never crash the
 * dispatcher).
 */
export function getGuardsForEvent(
  registrations: GuardRegistration[],
  event: LifecycleEvent,
  toolName?: string
): GuardRegistration[] {
  return registrations.filter((reg) => {
    if (reg.event !== event) return false;
    if (!reg.matcher) return true;
    if (!toolName) return false;
    try {
      return new RegExp(reg.matcher).test(toolName);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// D7(2) — duplicate-registration check (registry-completeness lint)
// ---------------------------------------------------------------------------

export interface DuplicateRegistration {
  a: string;
  b: string;
  event: LifecycleEvent;
  /** The matcher token(s) shared by both registrations. */
  sharedTokens: string[];
}

/**
 * Lifecycle events with NO tool-name concept — `matcher` is meaningless for
 * these (mirrors `getGuardsForEvent`'s "a matcher-less registration always
 * matches once its event matches" comment). Used by
 * {@link findDuplicateRegistrations} to scope the matcher-less-pair
 * exemption (R1 fix, mt#2652): the exemption is ONLY valid on these events.
 * `PreToolUse` and `PostToolUse` are tool-scoped — two matcher-less
 * registrations there genuinely both match every tool call, which IS a real
 * overlap risk and must still be flagged.
 */
export const NON_TOOL_SCOPED_EVENTS: ReadonlySet<LifecycleEvent> = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

/**
 * Detect two registrations with the same event and an overlapping matcher —
 * ADR-028 D7(2)'s "duplicate-registration check". Two matchers "overlap"
 * when they share at least one literal `|`-delimited alternative token (a
 * conservative, false-positive-tolerant heuristic — exact regex
 * intersection is undecidable in general, and today's matcher strings are
 * always simple `|`-joined tool-name alternatives, never true regex
 * features).
 *
 * A registration with no matcher is treated as "matches everything." When
 * matched against a registration THAT HAS a matcher, this is a genuine
 * overlap risk (the matcher-less guard fires on every tool the matchered
 * guard's tokens name too) and is still flagged — on EVERY event, tool-scoped
 * or not. When BOTH registrations in a pair lack a matcher, the exemption is
 * narrower: it applies ONLY on {@link NON_TOOL_SCOPED_EVENTS} (Phase 2a,
 * mt#2652; scope-corrected R1) — there, a matcher-less registration is the
 * NORMAL, by-design shape (there is no tool name to match against), and
 * multiple independent guards legitimately share it — e.g. the six
 * UserPromptSubmit guidance detectors migrated in this phase. On a
 * TOOL-SCOPED event (`PreToolUse`/`PostToolUse`), two matcher-less
 * registrations genuinely BOTH match every tool call — that is exactly the
 * accidental-duplicate shape D7(2) exists to catch, so it is still flagged
 * there.
 */
export function findDuplicateRegistrations(
  registrations: GuardRegistration[]
): DuplicateRegistration[] {
  const dupes: DuplicateRegistration[] = [];
  const tokensOf = (matcher: string | undefined): Set<string> | null =>
    matcher === undefined
      ? null
      : new Set(
          matcher
            .split("|")
            .map((t) => t.trim())
            .filter(Boolean)
        );

  for (let i = 0; i < registrations.length; i++) {
    for (let j = i + 1; j < registrations.length; j++) {
      const a = registrations[i];
      const b = registrations[j];
      if (!a || !b) continue;
      if (a.event !== b.event) continue;
      if (a.name === b.name) continue;

      const aTokens = tokensOf(a.matcher);
      const bTokens = tokensOf(b.matcher);
      if (aTokens === null && bTokens === null && NON_TOOL_SCOPED_EVENTS.has(a.event)) {
        // Both matcher-less on a non-tool-scoped event: the normal shape
        // for a family of independent guards — not a duplicate registration.
        continue;
      }
      if (aTokens === null || bTokens === null) {
        // Either exactly one side is matcher-less (genuine overlap risk on
        // any event), OR both sides are matcher-less on a TOOL-SCOPED event
        // (both genuinely match every tool call — still a real duplicate).
        dupes.push({
          a: a.name,
          b: b.name,
          event: a.event,
          sharedTokens: ["<matches everything>"],
        });
        continue;
      }
      const shared = [...aTokens].filter((t) => bTokens.has(t));
      if (shared.length > 0) {
        dupes.push({ a: a.name, b: b.name, event: a.event, sharedTokens: shared });
      }
    }
  }
  return dupes;
}
