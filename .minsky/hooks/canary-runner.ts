// Canary runner core — mt#2889 (evaluation-loop Phase 1 completion).
//
// The RFC's load-bearing broken-vs-dormant disambiguator: a guard that has
// never fired in the real fire-log is indistinguishable from "nobody has
// tripped this guard's real-world trigger condition yet" UNLESS there is a
// separate, synthetic-input check proving the guard's DECISION LOGIC still
// works. This module runs each GUARD_REGISTRY entry's declared `canary`
// (registry.ts's `GuardRegistration.canary` field) through the REAL guard
// module's exported `run()` — the exact function the dispatcher invokes in
// production — and reports whether the outcome matches the declared
// `expects` kind.
//
// Two historical incidents this closes: mt#2057 (retrospective-trigger-
// scanner's calibration log went silent for 9 days before an operator
// noticed by hand) and mt#2835 (auto-session-title's ungated module-level
// main() killed the whole UserPromptSubmit dispatcher process for 7 days,
// invisible because exit code stayed 0). Both would have been caught within
// a single run of this canary suite.
//
// Dependency-free (per `.minsky/hooks/SPEC.md`'s invariant): only imports
// from sibling files in this tree. The CLI wrapper (`scripts/run-guard-
// canaries.ts`) imports from here — `scripts/` already has precedent for
// importing directly from `.minsky/hooks/` (see `grant-guard-override.ts`,
// `grant-subagent-merge.ts`).
//
// @see mt#2889 — this task
// @see .minsky/hooks/registry.ts — GUARD_REGISTRY, GuardRegistration.canary
// @see docs/architecture/evaluation-loop-fire-log.md
// @see scripts/run-guard-canaries.ts — CLI entrypoint consuming this module

import { GUARD_REGISTRY } from "./registry";
import type { GuardRegistration, GuardRunResult, DispatchContext, GuardModule } from "./registry";
import { deriveBudgets, DEFAULT_HOST_CAP_SEC } from "./types";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";

// ---------------------------------------------------------------------------
// Canary evaluation (pure — no I/O)
// ---------------------------------------------------------------------------

export type CanaryExpectation = NonNullable<GuardRegistration["canary"]>["expects"];

/**
 * True iff `outcome` satisfies `expects`. Pure function — the sole seam
 * exercised directly by the sabotage-detection unit tests (see
 * `canary-runner.test.ts`), independent of any guard module or fs access.
 *
 * `outcome` is typed `GuardRunResult` (mt#2889 PR #2012 CI fix — the local
 * typecheck gap named in `buildCanaryContext`'s doc comment applies here
 * too: `.minsky/hooks/` is outside the root tsconfig, so only the SEPARATE
 * `tsconfig.hooks.json` CI check catches this class of hole). A guard's
 * `run()` returns `GuardOutcome | null | undefined | void` per registry.ts's
 * `GuardModule` contract — the real call site (`runGuardCanary` below) hands
 * this function that exact union, and `void` is not structurally the same
 * as `undefined` to a strict checker even though a `void`-returning function
 * always evaluates to `undefined` at runtime.
 */
export function evaluateCanaryOutcome(
  outcome: GuardRunResult,
  expects: CanaryExpectation
): boolean {
  if (!outcome) return false;
  switch (expects) {
    case "deny":
      return outcome.deny !== undefined;
    case "warn":
      return typeof outcome.additionalContext === "string" && outcome.additionalContext.length > 0;
    case "calibration":
      return outcome.calibration !== undefined;
    case "sessionTitle":
      return outcome.sessionTitle !== undefined;
    default: {
      // Exhaustiveness guard — if a new `expects` variant is ever added to
      // the registry's canary type without a matching case here, fail
      // loudly (as "not satisfied") rather than silently reporting a false
      // pass.
      const _exhaustive: never = expects;
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher-registry canary execution
// ---------------------------------------------------------------------------

export interface CanaryResult {
  guardName: string;
  /** "registry" (GUARD_REGISTRY entry, run via its exported run()) or "standalone" (a non-dispatcher guard's exported pure decision function). */
  source: "registry" | "standalone";
  expects: CanaryExpectation;
  /** Undefined when the guard has no declared canary yet (reported separately from pass/fail). */
  passed: boolean | undefined;
  /** Populated when the guard module threw, or when resolving/invoking it failed. */
  error?: string;
}

/**
 * Build a minimal synthetic DispatchContext for a canary invocation.
 *
 * `transcriptLines` is explicitly `TranscriptLine[] | undefined` (mt#2889 PR
 * #2012 R1 BLOCKING #1) — every real caller passes `canary.transcriptLines`,
 * an OPTIONAL field on the registry's canary declaration (most guards have no
 * transcript fixture at all). `DispatchContext["transcriptLines"]` itself is
 * non-optional (`TranscriptLine[]`, per registry.ts — the dispatcher always
 * resolves a concrete array, empty or not, before invoking any guard), so
 * typing this parameter as that non-optional field type — while every call
 * site actually passes a possibly-`undefined` value — was a type hole the
 * root tsconfig's typecheck can't catch (`.minsky/hooks/` is outside its
 * `include` set, per SPEC.md's dependency-free-tree invariant); only a
 * runtime crash on an unguarded `.length`/`.map` access downstream would have
 * surfaced it. The `?? []` fallback below was already runtime-safe; the fix
 * is making the signature honest about what it actually accepts.
 */
function buildCanaryContext(
  event: GuardRegistration["event"],
  transcriptLines: TranscriptLine[] | undefined
): DispatchContext {
  return {
    event,
    hostCapSec: DEFAULT_HOST_CAP_SEC,
    budgets: deriveBudgets(DEFAULT_HOST_CAP_SEC),
    transcriptCandidates: [],
    transcriptLines: transcriptLines ?? [],
  };
}

/** Minimal base ClaudeHookInput every canary's declared `input` fragment is merged onto. */
function baseCanaryInput(event: GuardRegistration["event"]): ToolHookInput {
  return {
    session_id: "mt2889-canary-session",
    cwd: process.cwd(),
    hook_event_name: event,
    tool_name: "",
    tool_input: {},
  };
}

/**
 * Run ONE `GUARD_REGISTRY` entry's declared canary through the REAL guard
 * module's exported `run()` — dynamically imported via the SAME `reg.module()`
 * loader the dispatcher itself uses, so a canary failure reflects the exact
 * production entry point, not a hand-copied stand-in.
 *
 * `moduleLoader` is injectable (defaults to `reg.module`) so tests can
 * substitute a SABOTAGED module (a synthetic "test copy" whose `run()`
 * always returns null/allow) without touching any real guard file on disk —
 * this is the seam `canary-runner.test.ts`'s sabotage-detection test uses.
 */
export async function runGuardCanary(
  reg: GuardRegistration,
  moduleLoader?: () => Promise<GuardModule>
): Promise<CanaryResult> {
  if (!reg.canary) {
    return { guardName: reg.name, source: "registry", expects: "deny", passed: undefined };
  }
  const { canary } = reg;
  try {
    const mod = await (moduleLoader ?? reg.module)();
    const ctx = buildCanaryContext(reg.event, canary.transcriptLines);
    let inputPatch: Record<string, unknown> = {};
    if (canary.setup) {
      inputPatch = (await canary.setup(mod, ctx)) ?? {};
    }
    const input: ToolHookInput = {
      ...baseCanaryInput(reg.event),
      ...canary.input,
      ...inputPatch,
    } as ToolHookInput;
    const outcome = await mod.run(input, ctx);
    return {
      guardName: reg.name,
      source: "registry",
      expects: canary.expects,
      passed: evaluateCanaryOutcome(outcome, canary.expects),
    };
  } catch (err) {
    return {
      guardName: reg.name,
      source: "registry",
      expects: canary.expects,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run every `GUARD_REGISTRY` entry's declared canary. Entries with no `canary` report `passed: undefined`. */
export async function runAllRegistryCanaries(
  registrations: GuardRegistration[] = GUARD_REGISTRY
): Promise<CanaryResult[]> {
  const results: CanaryResult[] = [];
  for (const reg of registrations) {
    results.push(await runGuardCanary(reg));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Standalone (non-GUARD_REGISTRY) guard canary declarations
// ---------------------------------------------------------------------------

/**
 * Canary declaration for a standalone (non-dispatcher) guard — the same
 * shape as `GuardRegistration.canary`, but paired with a `check` function
 * calling the guard's own exported pure decision function directly (no
 * `run(input, ctx)` contract exists for these; each standalone guard's
 * `if (import.meta.main)` block calls its own pure function differently).
 */
export interface StandaloneGuardCanary {
  guardName: string;
  expects: CanaryExpectation;
  /** Invokes the guard's real exported decision logic and returns its outcome-equivalent. Injectable for the sabotage test. */
  check: () => boolean | Promise<boolean>;
}

/** Run every declared standalone-guard canary. */
export async function runAllStandaloneCanaries(
  canaries: StandaloneGuardCanary[]
): Promise<CanaryResult[]> {
  const results: CanaryResult[] = [];
  for (const c of canaries) {
    try {
      const passed = await c.check();
      results.push({ guardName: c.guardName, source: "standalone", expects: c.expects, passed });
    } catch (err) {
      results.push({
        guardName: c.guardName,
        source: "standalone",
        expects: c.expects,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report formatting (pure — no I/O)
// ---------------------------------------------------------------------------

export interface CanaryReport {
  total: number;
  passed: number;
  failed: number;
  missing: number;
  allPassed: boolean;
  results: CanaryResult[];
}

/** Summarize a combined result list. `allPassed` is true only when every declared canary passed (missing canaries do NOT count as failures, but also don't count as passes). */
export function summarizeCanaryResults(results: CanaryResult[]): CanaryReport {
  let passed = 0;
  let failed = 0;
  let missing = 0;
  for (const r of results) {
    if (r.passed === undefined) missing++;
    else if (r.passed) passed++;
    else failed++;
  }
  return { total: results.length, passed, failed, missing, allPassed: failed === 0, results };
}

/** Render a human-readable report line for one result. */
export function formatCanaryResult(r: CanaryResult): string {
  const status = r.passed === undefined ? "MISSING" : r.passed ? "PASS" : "FAIL";
  const errSuffix = r.error ? ` (error: ${r.error})` : "";
  return `[${status}] ${r.guardName} (${r.source}, expects=${r.expects})${errSuffix}`;
}
