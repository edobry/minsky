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
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Canary fixture helpers (mt#2889 PR #2012 R1 BLOCKING #2 — portable defaults)
// ---------------------------------------------------------------------------

/**
 * Machine-independent absolute path matching `check-guessed-session-path.ts`'s
 * `SESSION_DIR_RE` (`[^\s'"]*\/state\/minsky\/sessions\/([^/\s'"]+)`) — that
 * regex only requires the literal substring `/state/minsky/sessions/<id>`
 * ANYWHERE in the string, so prefixing it with `os.tmpdir()` (instead of a
 * hardcoded developer home directory) satisfies the guard's detection while
 * working identically on any machine/user. The id itself is a fixed sentinel
 * UUID-shaped string that will never exist as a real session — `exists()`
 * (real `fs.existsSync`) always returns false for it, so the canary
 * deterministically triggers the guard's deny path.
 */
const CANARY_NONEXISTENT_SESSION_PATH = join(
  tmpdir(),
  "state",
  "minsky",
  "sessions",
  "00000000-canary-nonexistent-0000"
);

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
  /**
   * Static attention-cost annotation (mt#2597, evaluation-loop RFC Part 1).
   * Per the RFC: "Attention cost is annotated, not measured... a static
   * per-guard annotation derived from the guard's denial-message size and
   * option count — a registry field, not a per-fire measurement." Latency
   * (the fire-log's `durationMs`) is the LESSER cost dimension; this field
   * captures the vivid cost — reading a denial message, choosing among its
   * remediation options, writing an override rationale.
   *
   * Optional and NOT populated for every guard as of this Phase-1 landing —
   * see `docs/architecture/evaluation-loop-fire-log.md`'s "Known gaps"
   * section. A follow-up sweep should populate this for the remaining
   * guards; the field exists now so that sweep has a documented shape to
   * fill in.
   */
  attentionCost?: {
    /** Approx. character length of the guard's typical denial/warning message body. */
    denialMessageSizeChars: number;
    /** Number of distinct remediation options the guard's message presents (e.g. "override X, or do Y, or do Z" = 3). */
    optionCount: number;
  };
  /**
   * Canary declaration (mt#2889, evaluation-loop Phase 1 completion) — the
   * RFC's load-bearing broken-vs-dormant disambiguator. A guard with a
   * declared canary can be run through a SYNTHETIC input known to trigger a
   * specific outcome; a guard that stops firing on its own canary is BROKEN,
   * not merely dormant (low real-world trigger frequency). Without this,
   * mt#2057's dead retrospective-trigger hook (9 days silent) and mt#2835's
   * dead UserPromptSubmit dispatcher (7 days silent, killed by a sibling
   * guard's ungated `main()`) were both indistinguishable from "nobody
   * happened to trip this guard yet" until an operator noticed by hand.
   *
   * `input` is a `ClaudeHookInput`/`ToolHookInput` FRAGMENT — only the fields
   * this specific guard's `run()` actually reads need to be populated (the
   * canary runner, `scripts/run-guard-canaries.ts`, merges it onto a minimal
   * base input). `transcriptLines` is populated directly (bypassing a real
   * `transcript_path` file read) for `needsTranscript` guards — synthetic
   * `TranscriptLine[]` content, reusing phrases already present in the
   * guard's own source or `.test.ts` fixtures per this task's instruction
   * ("existing unit-test fixtures qualify as canary inputs — reuse them, do
   * not invent new ones").
   *
   * `expects` names which `GuardOutcome` field the canary input should
   * populate on a HEALTHY guard: `"deny"` (outcome.deny set), `"warn"`
   * (outcome.additionalContext set — the RFC's fire-log `"warn"` decision),
   * `"calibration"` (outcome.calibration set — a calibration-first detector
   * like `causal-premise-detector` with `INJECTION_ENABLED=false`), or
   * `"sessionTitle"` (outcome.sessionTitle set — `auto-session-title`'s
   * scalar-output shape).
   */
  canary?: {
    input: Partial<ClaudeHookInput> & Record<string, unknown>;
    transcriptLines?: TranscriptLine[];
    expects: "deny" | "warn" | "calibration" | "sessionTitle";
    /**
     * Optional pre-invocation priming hook for STATEFUL guards whose real
     * outcome depends on a prior invocation (e.g. `skill-staleness-detector`
     * only warns on its SECOND call for a given session — the first
     * establishes a baseline). Receives the SAME dynamically-imported guard
     * module and synthetic `DispatchContext` the real canary check will use,
     * so it can call `mod.run()` itself as many times as needed to prime
     * state before the canary runner's own (checked) invocation. May
     * optionally RETURN a partial input patch (e.g. a dynamically-generated
     * temp `cwd`/`session_id` the checked invocation must reuse) — merged
     * onto `canary.input` after `setup` completes, so the checked call sees
     * whatever state `setup` just primed. Most guards don't need this — omit
     * for anything whose outcome is determined by a single `run()` call.
     */
    setup?: (
      mod: GuardModule,
      ctx: DispatchContext
    ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
  };
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
// Phase 2a folded them in). `runDispatcher` concatenates `additionalContext`
// fragments in registry-array order, so resorting this array resorts what
// operators see. mt#2812 x mt#2824 merge (2026-07-16): guard-health-
// escalation-detector (mt#2812) and silent-stretch-detector (mt#2824) were
// each independently authored to land right after calibration-review-
// cadence-detector; both are appended here, BEFORE calibration-review-
// cadence-detector, which is relocated to stay the true last entry (its
// documented invariant — see the comment on that registration below).
export const GUARD_REGISTRY: GuardRegistration[] = [
  {
    name: "check-guessed-session-path",
    event: "PreToolUse",
    matcher: "Bash|mcp__minsky__session_exec",
    module: () => import("./check-guessed-session-path").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: true,
    // mt#2597: measured against buildDenialReason()'s fixed message body
    // (excluding the dynamic per-missing-path list) — ~398 chars; one
    // remediation option (the MINSKY_SKIP_SESSION_PATH_CHECK override).
    attentionCost: { denialMessageSizeChars: 398, optionCount: 1 },
    // mt#2889: a Bash command referencing an absolute sessions/<id>/ path
    // that has never existed on disk — findMissingInToolInput's exists()
    // check (real fs.existsSync, no synthetic override needed) always
    // returns false for this fixed sentinel path.
    canary: {
      input: {
        tool_name: "Bash",
        tool_input: {
          command: `cd ${CANARY_NONEXISTENT_SESSION_PATH}/ && ls`,
        },
      },
      expects: "deny",
    },
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
    // mt#2889: scalar sessionTitle output — no denial-message concept, no options.
    attentionCost: { denialMessageSizeChars: 0, optionCount: 0 },
    canary: {
      input: { session_id: "mt2889-canary-autotitle" },
      expects: "sessionTitle",
      // Seed the trigger file this guard's run() consumes+deletes (mirrors
      // session_start's real write path) — /tmp/claude-session-label-<sid>.json.
      setup: async () => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          "/tmp/claude-session-label-mt2889-canary-autotitle.json",
          JSON.stringify({ taskId: "mt#123", title: "Test task" })
        );
      },
    },
  },
  {
    name: "inject-current-time",
    event: "UserPromptSubmit",
    module: () => import("./inject-current-time").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 90, optionCount: 0 },
    // mt#2889: fires unconditionally on every UserPromptSubmit — the simplest liveness canary in the registry.
    canary: { input: {}, expects: "warn" },
  },
  {
    name: "inject-git-state",
    event: "UserPromptSubmit",
    module: () => import("./inject-git-state").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 200, optionCount: 0 },
    canary: {
      input: {}, // cwd populated dynamically by setup below
      expects: "warn",
      // mt#2889 PR #2012 R1 BLOCKING #3: the guard's run() requires `cwd` to
      // resolve as a real git repo (buildGitStateSnapshot returns null, and
      // the guard silently no-ops, otherwise) — relying on the canary
      // RUNNER's own ambient process.cwd() being a git checkout was flaky
      // (true only when invoked from within a repo; false in CI contexts or
      // other invocation cwds). Init a disposable, hermetic throwaway repo in
      // a fresh temp dir instead — a single commit is enough for
      // `git symbolic-ref HEAD` / `git log` / `git status` to all resolve
      // cleanly, giving a deterministic "clean, default-branch-undetectable"
      // snapshot (no origin configured) regardless of where the canary
      // runner itself is invoked from.
      setup: async () => {
        const { mkdtempSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const cwd = mkdtempSync(join(tmpdir(), "mt2889-git-state-canary-"));
        const run = (args: string[]): void => {
          Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
        };
        run(["init", "--initial-branch=main"]);
        run(["config", "user.email", "canary@example.invalid"]);
        run(["config", "user.name", "mt2889 canary"]);
        writeFileSync(join(cwd, "canary.txt"), "canary fixture\n");
        run(["add", "canary.txt"]);
        run(["commit", "-m", "canary fixture commit"]);
        return { cwd };
      },
    },
  },
  {
    name: "inject-prod-state",
    event: "UserPromptSubmit",
    module: () => import("./inject-prod-state").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 250, optionCount: 0 },
    // mt#2889: no cache file present in the canary runner's isolated
    // MINSKY_STATE_DIR -> deterministic UNKNOWN branch fires additionalContext.
    canary: { input: {}, expects: "warn" },
  },
  {
    name: "inject-dispatch-watchdog",
    event: "UserPromptSubmit",
    module: () => import("./inject-dispatch-watchdog").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 450, optionCount: 3 },
    canary: {
      input: {},
      expects: "warn",
      // Seed a stalled-dispatch flag in the isolated MINSKY_STATE_DIR cache.
      setup: async () => {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const stateDir = process.env["MINSKY_STATE_DIR"];
        if (!stateDir) return;
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(
          join(stateDir, "dispatch-watchdog-cache.json"),
          JSON.stringify({
            checkedAt: new Date().toISOString(),
            staleMs: 1_800_000,
            flags: [
              {
                taskId: "mt#0000",
                subagentSessionId: "mt2889-canary-session",
                agentType: "implementer",
                taskStatus: "IN-PROGRESS",
                startedAt: new Date(Date.now() - 3_600_000).toISOString(),
                lastActivityAt: new Date(Date.now() - 1_800_000).toISOString(),
                staleForMs: 1_800_000,
              },
            ],
          })
        );
      },
    },
  },
  {
    name: "memory-search",
    event: "UserPromptSubmit",
    module: () => import("./memory-search").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 280, optionCount: 1 },
    // mt#3004 (closes the mt#2889 KNOWN GAP): the live `minsky memory search`
    // subprocess is not hermetically canary-able, so the guard exposes a
    // fixture-file stub seam (CANARY_STUB_ENV) that replaces ONLY the
    // subprocess call — the fixture flows through the real parse/injection
    // path. The seam is gated on CANARY_MODE_ENV (PR #2145 R1) and this
    // setup's env mutations are restored by runGuardCanary after the
    // checked invocation, so nothing leaks to sibling canaries or the host
    // process.
    canary: {
      input: {
        prompt:
          "canary: verify the memory-search hook still parses results and injects context for this prompt",
      },
      expects: "warn",
      setup: async () => {
        const { mkdtempSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { CANARY_MODE_ENV } = await import("./types");
        const { CANARY_STUB_ENV } = await import("./memory-search");
        const dir = mkdtempSync(join(tmpdir(), "mt3004-memory-search-canary-"));
        const fixturePath = join(dir, "memory-search-fixture.json");
        writeFileSync(
          fixturePath,
          JSON.stringify({
            results: [
              {
                record: {
                  id: "00000000-0000-0000-0000-mt3004canary",
                  type: "feedback",
                  name: "mt3004_canary_fixture_memory",
                  description: "Synthetic canary fixture record (mt#3004).",
                  content:
                    "Synthetic memory content used by the guard-canary suite to prove the " +
                    "memory-search hook's parse-and-inject plumbing is alive.",
                },
                score: 0.11,
              },
            ],
            backend: "embeddings",
            degraded: false,
          })
        );
        process.env[CANARY_MODE_ENV] = "1";
        process.env[CANARY_STUB_ENV] = fixturePath;
        return {};
      },
    },
  },
  {
    name: "skill-staleness-detector",
    event: "UserPromptSubmit",
    module: () => import("./skill-staleness-detector").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 350, optionCount: 2 },
    canary: {
      input: {}, // cwd/session_id populated dynamically by setup below
      expects: "warn",
      // Two-invocation stateful guard: first call establishes a baseline
      // mtime snapshot for a synthetic watched file in an isolated cwd; this
      // setup then advances that file's mtime so the canary runner's own
      // (checked) SECOND invocation sees a change and warns.
      setup: async (mod, ctx) => {
        const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const cwd = mkdtempSync(join(tmpdir(), "mt2889-skill-staleness-canary-"));
        const skillDir = join(cwd, ".claude", "skills", "canary-skill");
        mkdirSync(skillDir, { recursive: true });
        const skillFile = join(skillDir, "SKILL.md");
        writeFileSync(skillFile, "# canary skill\n");
        const sessionId = "mt2889-canary-skillstale";
        const primeInput = {
          session_id: sessionId,
          cwd,
          hook_event_name: "UserPromptSubmit",
          tool_name: "",
          tool_input: {},
        };
        await mod.run(primeInput, ctx); // baseline established; no warning expected yet
        const future = new Date(Date.now() + 5000);
        utimesSync(skillFile, future, future);
        return { session_id: sessionId, cwd };
      },
    },
  },
  {
    name: "mcp-daemon-staleness-detector",
    event: "UserPromptSubmit",
    module: () => import("./mcp-daemon-staleness-detector").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 400, optionCount: 1 },
    // mt#3004 (closes the mt#2889 KNOWN GAP): the "scratch git-repo fixture"
    // this gap deferred now follows the inject-git-state canary's precedent —
    // a two-commit repo whose second commit touches src/, plus a daemon state
    // file (startCommit = first commit) under the canary runner's isolated
    // MINSKY_STATE_DIR. The session tracker is redirected to a temp HOME via
    // TRACKER_HOME_ENV (gated on CANARY_MODE_ENV, PR #2145 R1) so nothing
    // lands under the real ~/.claude (mt#2876 class). Env mutations are
    // restored by runGuardCanary after the checked invocation. The state
    // file is read only by this guard, so writing it into the shared
    // isolated state dir cannot affect sibling canaries.
    canary: {
      input: {},
      expects: "warn",
      setup: async () => {
        const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { spawnSync } = await import("node:child_process");
        const { CANARY_MODE_ENV } = await import("./types");
        const { TRACKER_HOME_ENV } = await import("./mcp-daemon-staleness-detector");
        const repo = mkdtempSync(join(tmpdir(), "mt3004-daemon-staleness-canary-repo-"));
        const run = (args: string[]) =>
          spawnSync("git", args, { cwd: repo, stdio: "ignore", timeout: 5000 });
        // PR #2145 R1: surface git-unavailable clearly instead of a
        // confusing downstream mismatch; fall back to plain `git init` for
        // git versions without --initial-branch (< 2.28).
        const init = run(["init", "--initial-branch=main"]);
        if (init.error) {
          throw new Error(
            `canary setup: git unavailable (${init.error.message}) — the daemon-staleness canary requires git`
          );
        }
        if (init.status !== 0) {
          const plainInit = run(["init"]);
          if (plainInit.error || plainInit.status !== 0) {
            throw new Error("canary setup: git init failed in the scratch repo");
          }
        }
        run(["config", "user.email", "canary@example.invalid"]);
        run(["config", "user.name", "mt3004 canary"]);
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "canary.ts"), "export const canary = 1;\n");
        run(["add", "."]);
        run(["commit", "-m", "canary baseline commit"]);
        const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: repo,
          encoding: "utf8",
          timeout: 5000,
        });
        const startCommit = headResult.stdout?.trim();
        if (headResult.error || !startCommit) {
          throw new Error(
            `canary setup: git rev-parse produced no SHA in the scratch repo — ${headResult.error?.message ?? "baseline commit likely failed"}`
          );
        }
        writeFileSync(join(repo, "src", "canary.ts"), "export const canary = 2;\n");
        run(["add", "."]);
        run(["commit", "-m", "canary drift commit (touches src/)"]);
        const stateDir = process.env["MINSKY_STATE_DIR"];
        if (!stateDir) throw new Error("canary runner did not set MINSKY_STATE_DIR");
        writeFileSync(
          join(stateDir, "mcp-daemon-state.json"),
          JSON.stringify({
            startCommit,
            startTimestamp: new Date().toISOString(),
            pid: process.pid,
            serverName: "minsky",
            minskyHomeDir: repo,
            transport: "stdio",
          })
        );
        process.env[CANARY_MODE_ENV] = "1";
        process.env[TRACKER_HOME_ENV] = mkdtempSync(
          join(tmpdir(), "mt3004-daemon-staleness-canary-home-")
        );
        return { session_id: "mt3004-canary-daemonstale" };
      },
    },
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
    attentionCost: { denialMessageSizeChars: 1000, optionCount: 4 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll save this insight for later." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "warn",
    },
  },
  {
    name: "retrospective-trigger-scanner",
    event: "UserPromptSubmit",
    module: () => import("./retrospective-trigger-scanner").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "retrospective-trigger",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 400, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I owe you an apology for that mistake." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "warn",
    },
  },
  {
    name: "pre-narration-detector",
    event: "UserPromptSubmit",
    module: () => import("./pre-narration-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "pre-narration",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 500, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I created the PR and it's ready." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "warn",
    },
  },
  {
    name: "causal-premise-detector",
    event: "UserPromptSubmit",
    module: () => import("./causal-premise-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "causal-premise",
    denyCapable: false,
    needsTranscript: true,
    // mt#2889: INJECTION_ENABLED=false — this detector is calibration-first
    // (dormant by flag). The canary asserts the calibration outcome, not
    // additionalContext, so a future INJECTION_ENABLED flip doesn't silently
    // break this canary (it would simply gain an ADDITIONAL warn outcome).
    attentionCost: { denialMessageSizeChars: 550, optionCount: 2 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The branch name got mangled due to the encoding configuration in the client library.",
              },
            ],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "calibration",
    },
  },
  {
    name: "code-mechanism-assertion-detector",
    event: "UserPromptSubmit",
    module: () => import("./code-mechanism-assertion-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "code-mechanism-assertion",
    denyCapable: false,
    needsTranscript: true,
    // mt#3002: INJECTION_ENABLED=true — LIVE since 2026-07-21, no longer
    // dormant (the mt#2889 calibration-first gate flipped after the
    // mt#2483 calibration-review sweep disposed the residual FP rate).
    // Canary below still asserts calibration (the calibration-log write),
    // not warn — it does not assert the absence of additionalContext.
    attentionCost: { denialMessageSizeChars: 500, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "`executeCommand` clamps maxBuffer to 10MB." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "calibration",
    },
  },
  {
    name: "ask-routing-deferral-detector",
    event: "UserPromptSubmit",
    module: () => import("./ask-routing-deferral-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "ask-routing-deferral",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 500, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "That decision is yours to make." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "warn",
    },
  },
  // -------------------------------------------------------------------------
  // mt#3125 — root-tier sibling of the guidance-detector family above. Fires
  // on the BATCH itself (an id-minting call + an id-consuming call in the
  // same parallel tool-call batch) rather than a downstream symptom surface
  // (mt#2195's fs path, mt#2197's narrated prose). Calibration-first
  // (INJECTION_ENABLED=false in the module) — see the module header.
  // -------------------------------------------------------------------------
  {
    name: "constructed-identifier-batch-detector",
    event: "UserPromptSubmit",
    module: () => import("./constructed-identifier-batch-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "constructed-identifier-batch",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 600, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "mcp__minsky__tasks_create",
                input: { title: "canary task" },
              },
              {
                type: "tool_use",
                name: "mcp__minsky__session_commit",
                input: { message: "fix(mt#0000): canary commit referencing the minted id" },
              },
            ],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      // Calibration-first (INJECTION_ENABLED=false) — same posture as
      // causal-premise-detector's canary above: assert the calibration
      // outcome, not additionalContext, so a future INJECTION_ENABLED flip
      // doesn't silently break this canary (it would simply gain an
      // ADDITIONAL warn outcome).
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#2459 — operator-deferral family (probe-before-defer / operator-must-do-X).
  // TWO surfaces from ONE module, sharing ONE calibration log (they are two
  // detection surfaces on one failure family): the UserPromptSubmit prose scan
  // here, and the PreToolUse `AskUserQuestion` option-label scan below it. Both
  // calibration-first (INJECTION_ENABLED=false in the module). The
  // ACTIVATION-instruction half of this family belongs to
  // substrate-bypass-detector's mt#2303 surface — see that module's
  // SCOPE BOUNDARY note before adding a pattern to either.
  // -------------------------------------------------------------------------
  {
    name: "operator-deferral-detector",
    event: "UserPromptSubmit",
    module: () => import("./operator-deferral-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "operator-deferral",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 600, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Deferred to operator: requires Railway access." }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      // Calibration-first (INJECTION_ENABLED=false) — assert the calibration
      // outcome, not additionalContext, so a future flip doesn't break the
      // canary (it would simply gain an ADDITIONAL warn outcome).
      expects: "calibration",
    },
  },
  {
    name: "operator-deferral-ask-surface",
    event: "PreToolUse",
    matcher: "AskUserQuestion",
    module: () => import("./operator-deferral-detector").then((m) => ({ run: m.runAskSurface })),
    timeoutMs: 10000,
    calibrationLog: "operator-deferral",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 600, optionCount: 1 },
    canary: {
      input: {
        transcript_path: "mt2889-canary-transcript",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "The reviewer service is CRASHED. How should we proceed?",
              options: [{ label: "You recover the reviewer service" }],
            },
          ],
        },
      },
      transcriptLines: [{ type: "user", message: { role: "user", content: "first turn" } }],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#2812 — new guard, not part of any legacy settings.json migration.
  // Reads the guard-health JSONL log (a pure fs read + string compare, no
  // network/git calls) and injects a warning when any guard has reached
  // "critical" escalation (3+ consecutive errors/check-skips).
  // -------------------------------------------------------------------------
  {
    name: "guard-health-escalation-detector",
    event: "UserPromptSubmit",
    module: () => import("./guard-health-escalation-detector").then((m) => ({ run: m.run })),
    timeoutMs: 5000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 300, optionCount: 0 },
    canary: {
      input: {},
      expects: "warn",
      // Seed 3 consecutive error events for a synthetic guard name in the
      // canary runner's isolated MINSKY_STATE_DIR guard-health-log.jsonl —
      // CRITICAL_STREAK_THRESHOLD=2 means streak > 2 (i.e. 3+) escalates to
      // "critical" (see guard-health.ts).
      setup: async () => {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const stateDir = process.env["MINSKY_STATE_DIR"];
        if (!stateDir) return;
        mkdirSync(stateDir, { recursive: true });
        const now = Date.now();
        const lines = [0, 1, 2]
          .map((i) =>
            JSON.stringify({
              timestamp: new Date(now - (2 - i) * 60_000).toISOString(),
              guardName: "mt2889-canary-fixture-guard",
              event: "PreToolUse",
              kind: "error",
              errorClass: "Error",
              message: "canary-fixture-error",
            })
          )
          .join("\n");
        writeFileSync(join(stateDir, "guard-health-log.jsonl"), `${lines}\n`);
      },
    },
  },
  // -------------------------------------------------------------------------
  // mt#2824 — silent-stretch heartbeat detector. New guard authored directly
  // onto this framework (not a migrated legacy standalone hook), so it has
  // no bespoke pre-migration settings.json slot to preserve ordering for.
  // Needs transcriptLines (D6) to walk the just-completed turn for
  // tool-only silence.
  // -------------------------------------------------------------------------
  {
    name: "silent-stretch-detector",
    event: "UserPromptSubmit",
    module: () => import("./silent-stretch-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "silent-stretch",
    denyCapable: false,
    needsTranscript: true,
    // mt#2889: INJECTION_ENABLED=false — calibration-first (dormant by flag),
    // same rationale as causal-premise-detector above.
    attentionCost: { denialMessageSizeChars: 400, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        {
          type: "user",
          message: { role: "user", content: "start" },
          timestamp: "2026-01-01T00:00:00Z",
        },
        // TOOL_CALL_THRESHOLD=15 consecutive tool_use-only assistant lines,
        // zero assistant TEXT in between — crosses the tool-count cadence
        // bar regardless of the wall-clock gap threshold.
        ...Array.from({ length: 15 }, (_, i) => ({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Bash", input: {} }],
          },
          timestamp: `2026-01-01T00:00:${String(i + 1).padStart(2, "0")}Z`,
        })),
        {
          type: "user",
          message: { role: "user", content: "still going" },
          timestamp: "2026-01-01T00:00:16Z",
        },
      ],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#2870 — wall-of-text turn-report shape detector. The OVER-signaling
  // sibling of silent-stretch-detector above (communication-altitude RFC
  // Phase 3): measures the just-completed turn's FINAL assistant text block
  // against the Tier-1 contract shape (communication-contract.mdc).
  // Authored directly onto this framework — no bespoke pre-migration
  // settings.json slot. Needs transcriptLines (D6).
  // -------------------------------------------------------------------------
  {
    name: "wall-of-text-detector",
    event: "UserPromptSubmit",
    module: () => import("./wall-of-text-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "wall-of-text",
    denyCapable: false,
    needsTranscript: true,
    // mt#3112: INJECTION_ENABLED=true — LIVE since 2026-07-23 (the mt#2483
    // calibration-review sweep, ask 109807e1/ask#5425, disposed 60 lifetime
    // fires + a confirmed operator-bounced true positive as a flip, paired
    // with a depth-request override that suppresses-but-logs). Canary below
    // still asserts calibration (the calibration-log write), not warn — it
    // does not assert the presence/absence of additionalContext (mirrors
    // code-mechanism-assertion-detector's identical canary note above).
    attentionCost: { denialMessageSizeChars: 400, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2889-canary-transcript" },
      transcriptLines: [
        {
          type: "user",
          message: { role: "user", content: "start" },
          timestamp: "2026-01-01T00:00:00Z",
        },
        // A 900-word, label-heavy final report — crosses BOTH the 2x-budget
        // word threshold and the lead-label pattern bar (the mt#2870
        // acceptance-test shape).
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Gate (l) verdict and premise audit (iii): ${Array.from(
                  { length: 893 },
                  (_, i) => `w${i}`
                ).join(" ")}`,
              },
            ],
          },
          timestamp: "2026-01-01T00:00:05Z",
        },
        {
          type: "user",
          message: { role: "user", content: "still going" },
          timestamp: "2026-01-01T00:00:10Z",
        },
      ],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#2923 — build/deploy-claim seam detector (mt#2707 RFC Part 2). New
  // guard, not part of any legacy settings.json migration. Fires ONLY on the
  // seam no reactive detector reaches: a chat-only usability/delivery claim
  // after an in-session build/deploy-surface merge with no rebuild evidence.
  // Needs transcriptLines (D6) to walk the whole session for the merge +
  // deploy-surface-edit + rebuild-evidence signals, not just the last turn.
  // -------------------------------------------------------------------------
  {
    name: "build-claim-injection-detector",
    event: "UserPromptSubmit",
    module: () => import("./build-claim-injection-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "build-claim-injection",
    denyCapable: false,
    needsTranscript: true,
    // mt#2923: INJECTION_ENABLED=false — calibration-first, same rationale as
    // causal-premise-detector above; canary asserts calibration, not warn.
    attentionCost: { denialMessageSizeChars: 500, optionCount: 1 },
    canary: {
      input: { transcript_path: "mt2923-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "mcp__minsky__session_edit_file",
                input: { path: "cockpit-tray/src-tauri/src/main.rs" },
              },
              {
                type: "tool_use",
                name: "mcp__minsky__session_pr_merge",
                input: { task: "mt#0000" },
              },
              {
                type: "text",
                text: "The tray app is updated and ready — you can use it now.",
              },
            ],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
      ],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // mt#2708 — knowledge-acquisition detector (mt#2707 RFC's B proactive-
  // trigger half of the learn-capture primitive). New guard, not part of any
  // legacy settings.json migration. Fires on in-task research relevant to a
  // loaded skill with no propagation (memory_create / /learn / tasks_create)
  // in a trailing window of turns. Needs transcriptLines (D6) to scan the
  // WHOLE session (loaded skills + research occurrences), not just the last
  // turn — mirrors build-claim-injection-detector.ts's widening.
  // -------------------------------------------------------------------------
  {
    name: "knowledge-acquisition-detector",
    event: "UserPromptSubmit",
    module: () => import("./knowledge-acquisition-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "knowledge-acquisition",
    denyCapable: false,
    needsTranscript: true,
    // mt#2708: INJECTION_ENABLED=false — calibration-first, same rationale as
    // causal-premise-detector/build-claim-injection-detector above; canary
    // asserts calibration, not warn.
    attentionCost: { denialMessageSizeChars: 400, optionCount: 1 },
    canary: {
      // input.cwd defaults to the canary runner's real process.cwd() (a real
      // repo checkout, per baseCanaryInput) — readSkillDescription resolves
      // the REAL `.claude/skills/engineering-writing/SKILL.md` frontmatter,
      // so the canary exercises the rung-2-lite keyword-overlap gate against
      // real skill data, not a synthetic stand-in. `session_id` is a
      // canary-only literal, distinct from any real conversation id, so the
      // dedupe read in `loadAlreadyLoggedDedupeKeys` can never match a
      // genuine prior record and silently suppress this canary forever.
      input: { session_id: "mt2708-canary-session", transcript_path: "mt2708-canary-transcript" },
      transcriptLines: [
        { type: "user", message: { role: "user", content: "first turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Skill", input: { skill: "engineering-writing" } }],
          },
        },
        { type: "user", message: { role: "user", content: "second turn" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "WebSearch",
                input: { query: "argumentative prose AI writing tells overused phrases" },
              },
            ],
          },
        },
        // TRAILING_WINDOW_TURNS (5) filler turns so the grace period has elapsed.
        ...Array.from({ length: 5 }, (_, i) => [
          { type: "user", message: { role: "user", content: `filler turn ${i}` } },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "continuing" }] },
          },
        ]).flat(),
        { type: "user", message: { role: "user", content: "current turn" } },
      ],
      expects: "calibration",
    },
  },
  // -------------------------------------------------------------------------
  // Stop event (mt#2357) — the framework's FIRST Stop-event guard. Runs via
  // the new `dispatch-stop.ts` entrypoint. Placed BEFORE the
  // calibration-review-cadence-detector entry to preserve that entry's
  // documented literal-LAST-entry invariant; cross-event array order is
  // inert (getGuardsForEvent filters by event before running in order).
  // -------------------------------------------------------------------------
  {
    name: "turn-end-retro-scan",
    event: "Stop",
    module: () => import("./turn-end-retro-scan").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    calibrationLog: "retrospective-trigger",
    denyCapable: false,
    needsTranscript: true,
    attentionCost: { denialMessageSizeChars: 600, optionCount: 2 },
    canary: {
      // The guard reads ctx.transcriptLines (needsTranscript) plus the
      // Stop-specific last_assistant_message; session_id keys the dedup
      // store, which setup clears so the canary is repeatable (an
      // un-cleared store would dedup the SECOND canary run into silence
      // and misreport the guard as broken).
      input: {
        session_id: "mt2357-turn-end-canary",
        transcript_path: "/nonexistent/mt2357-canary.jsonl",
        last_assistant_message: "I made a mistake in the deploy step.",
      },
      transcriptLines: [
        {
          type: "user",
          message: { role: "user", content: "please deploy the service" },
          uuid: "mt2357-canary-prompt",
          timestamp: "2026-07-21T00:00:00.000Z",
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Deploying now." }] },
        },
      ],
      expects: "warn",
      setup: async () => {
        const store = await import("./turn-end-scan-store");
        store.clearFlagged("mt2357-turn-end-canary");
      },
    },
  },
  // -------------------------------------------------------------------------
  // Phase 2b (mt#2687) — calibration-review-cadence-detector sat AFTER the
  // Phase 2a dispatcher slot in the pre-migration settings.json order. Kept
  // as the LAST entry across the mt#2812 x mt#2824 merge (2026-07-16): both
  // new guards above were independently appended right after this entry on
  // their respective branches; re-appending it last here preserves the
  // documented invariant
  // (docs/architecture/hooks/calibration-review-cadence-detector.md: "the
  // LAST entry") through the additive merge of both new guards.
  // -------------------------------------------------------------------------
  {
    name: "calibration-review-cadence-detector",
    event: "UserPromptSubmit",
    module: () => import("./calibration-review-cadence-detector").then((m) => ({ run: m.run })),
    timeoutMs: 10000,
    denyCapable: false,
    attentionCost: { denialMessageSizeChars: 300, optionCount: 1 },
    canary: {
      input: {}, // cwd populated dynamically by setup below
      expects: "warn",
      // Seed a registered calibration log (causal-premise) with >= FIRES_THRESHOLD
      // (10) fires and >= DIVERSITY_THRESHOLD (3) distinct phrases, no watermark
      // present -> pastThreshold fires review-due. Resolved relative to
      // input.cwd (this guard resolves every path via `resolve(input.cwd)`).
      setup: async () => {
        const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const cwd = mkdtempSync(join(tmpdir(), "mt2889-cadence-canary-"));
        mkdirSync(join(cwd, ".minsky"), { recursive: true });
        const lines = Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({
            timestamp: new Date().toISOString(),
            session_id: "mt2889-canary",
            matchedPhrases: [`canary-phrase-${i % 4}`],
            hadSameTurnVerification: false,
          })
        ).join("\n");
        writeFileSync(join(cwd, ".minsky", "causal-premise-calibration.jsonl"), `${lines}\n`);
        return { cwd };
      },
    },
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
