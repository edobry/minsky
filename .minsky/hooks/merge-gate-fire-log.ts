// Shared fire-log entry-point wrapper for standalone merge-gate PreToolUse
// hooks — mt#3084 (evaluation-loop Phase 3 build-out).
//
// `docs/architecture/evaluation-loop-fire-log.md`'s "Merge-gate fire-log
// absence" section (filed by mt#3078's classification) documented the ~10
// standalone `session_pr_merge` PreToolUse hooks as a deliberate Phase-1/
// Phase-2 (mt#2597/mt#2889) scope exclusion, not a wiring bug. This module is
// the Phase-3 build-out those docs named mt#3084 as the owner of.
//
// Every one of the ~10 gates already follows the SAME shape other
// fire-log-instrumented standalone guards use (block-git-gh-cli.ts,
// check-branch-fresh.ts, check-task-spec-read.ts): a bare
// `if (import.meta.main) { const input = await readInput(...); ... }` block
// with many early `process.exit(0)` exit points (implicit allow) and
// `writeOutput({...); process.exit(0);` exit points (deny, or an
// additionalContext-only warn). This factory gives every one of those exit
// points a one-line `recordAndExit(decision)` call in place of a bare
// `process.exit(0)` — it does NOT change what any gate decides (mt#3084's
// hard constraint #1); it only records what was already decided.
//
// Fail-safe by construction (mt#3084 hard constraint #2): `recordFireLogEntry`
// itself never throws — every fs failure is swallowed and degraded to a
// stderr marker (see fire-log.ts). This factory adds no additional risk
// surface beyond that: it is pure closure construction plus a `Date.now()`
// diff, no I/O of its own.
//
// Dependency-free per `.minsky/hooks/SPEC.md`'s invariant — this module only
// imports the sibling `fire-log.ts`, itself dependency-free.
//
// @see mt#3084 — this task
// @see docs/architecture/evaluation-loop-fire-log.md — schema + the merge-gate-absence classification this closes
// @see .minsky/hooks/fire-log.ts — recordFireLogEntry / classifyOverride, the shared recording API this wraps
// @see .minsky/hooks/block-git-gh-cli.ts / check-branch-fresh.ts / check-task-spec-read.ts — the established per-hook `recordAndExit` closure pattern this factory generalizes

import {
  recordFireLogEntry,
  type FireLogDecision,
  type FireLogRecordOptions,
  type OverrideClassification,
  type RecordFireLogInput,
  type TaskResolutionSource,
} from "./fire-log";

/** The subset of `ToolHookInput` this factory needs — `tool_name`/`session_id` are
 * always present on a real hook invocation (see `.minsky/hooks/types.ts`'s
 * `ClaudeHookInput`/`ToolHookInput`), so no optional-chaining is needed at the
 * call site. */
export interface MergeGateHookInput {
  tool_name: string;
  session_id: string;
}

export interface MergeGateOverrideFields {
  /** Omitted for a grant-channel override (e.g. the mt#2658 D8 grant store) — a
   * grant has no env-var name; use `overrideSource: "grant"` for that case
   * instead, mirroring `dispatcher.ts`'s `buildOverrideFireLogFields`. */
  overrideEnvVar?: string;
  overrideClassification: OverrideClassification;
  /** Which channel decided the override, when a hook's override can come from
   * more than one (env var vs a TTL-bound, reason-mandatory grant). Omit for
   * hooks with only one override channel (the common case). */
  overrideSource?: "env" | "grant";
  /** mt#2989 — the authorization Ask id backing a grant-channel override, so the
   * fire-log record names the operator authorization, not just its class. */
  overrideGrantAsk?: string;
}

/**
 * mt#3355 — a MUTABLE holder a merge gate fills in once, right after it resolves the task
 * id, and which the `recordAndExit` closure reads at whichever exit point actually fires.
 *
 * Deliberately mutable rather than a per-call argument: a merge gate has many exit points
 * downstream of task resolution, and threading the source through each one would make
 * "forgot to pass it at exit point N" a live failure mode — which is the same shape as the
 * bug mt#3355 exists to fix (a gate whose non-evaluation was indistinguishable from a pass).
 * With a shared holder, every exit point after the assignment carries the source by
 * construction, and the ones before it correctly carry nothing.
 */
export interface MergeGateFireLogContext {
  taskResolutionSource?: TaskResolutionSource;
}

/** The `recordAndExit` closure shape every merge-gate hook's entry point uses. */
export type RecordAndExit = (
  decision: FireLogDecision,
  overrideFields?: MergeGateOverrideFields
) => never;

/**
 * The exit code every merge-gate exit point terminates with. A PreToolUse hook's
 * actual permission decision travels in the JSON it already wrote to stdout, never in
 * its exit status — a non-zero exit is read by the harness as "the hook itself broke",
 * which is precisely the fail-open shape mt#2810 documents. So `deny` exits 0 too.
 */
const MERGE_GATE_EXIT_CODE = 0;

/**
 * The value one merge-gate exit point represents: the fire-log record to write, and
 * the code the process should terminate with. Pure data — building one performs no
 * I/O and does not exit, so a test asserts on it by return value (mt#3630).
 */
export interface MergeGateDecision {
  exitCode: number;
  record: RecordFireLogInput;
}

/** Builds the {@link MergeGateDecision} for one exit point. Pure; no I/O, no exit. */
export type MergeGateDecider = (
  decision: FireLogDecision,
  overrideFields?: MergeGateOverrideFields
) => MergeGateDecision;

/**
 * The PURE half of {@link makeRecordAndExit} (mt#3630): captures the same
 * `guardName`/`startMs`/`input`/`context` and turns one exit point into a
 * `{ exitCode, record }` decision value — but writes nothing and exits nothing.
 *
 * Split out so the record-construction contract (the mt#3084 field set, and mt#3355's
 * read-at-EXIT-time `taskResolutionSource`) is testable by return value instead of by
 * patching `process.exit` out from under the test process. The write-and-exit half is
 * {@link dispatchMergeGateDecision}; `makeRecordAndExit` composes the two so every
 * guard call site keeps its unchanged, can't-forget-to-exit `never`-typed shape.
 *
 * `nowMs` is test-only DI (defaults to `Date.now`) — production never passes it.
 */
export function makeMergeGateDecider(
  guardName: string,
  startMs: number,
  input: MergeGateHookInput,
  context?: MergeGateFireLogContext,
  nowMs: () => number = Date.now
): MergeGateDecider {
  return (decision, overrideFields) => ({
    exitCode: MERGE_GATE_EXIT_CODE,
    record: {
      guardName,
      event: "PreToolUse",
      decision,
      durationMs: nowMs() - startMs,
      toolName: input.tool_name,
      sessionId: input.session_id,
      // mt#3355: read at EXIT time, not decider-construction time — the gate assigns
      // this after it resolves the task id, which happens after this factory runs.
      ...(context?.taskResolutionSource !== undefined
        ? { taskResolutionSource: context.taskResolutionSource }
        : {}),
      // Reviewer R2 BLOCKING (verified false positive, mt#3084): spreading an
      // `undefined` value into an object literal is a JS-spec no-op ({...undefined}
      // === {}), NOT a runtime throw — confirmed empirically (`bun -e`) before this
      // comment was written, per the /implement-task diagnostic ladder's
      // "verified-false-positive" condition. `overrideFields` is `undefined` on
      // every non-override call site (the overwhelming majority — every plain
      // allow/deny/warn with no escape hatch consulted), so this path already ran
      // correctly in all 619 passing tests plus the mt#3084 PR's synthetic
      // live-invocation verification. The `?? {}` below is redundant defensive
      // clarity, not a behavior change — it exists so a future reader (or
      // static-analysis reviewer) doesn't need to re-derive the object-spread
      // vs. array/call-spread distinction from scratch.
      ...(overrideFields ?? {}),
    },
  });
}

/**
 * The IMPERATIVE half (mt#3630): write the record, then exit. Its only job — it makes
 * no decisions, so the "did this gate decide correctly" question is answered entirely
 * by {@link makeMergeGateDecider}'s pure return value.
 *
 * Stays `never`-typed so composing it into `makeRecordAndExit` preserves the
 * can't-forget-to-record-and-exit ergonomic the mt#3084 shape was chosen for: a guard
 * exit point that calls `recordAndExit(...)` cannot fall through.
 *
 * Fail-safe by construction: `recordFireLogEntry` never throws (see fire-log.ts), so a
 * broken log destination can never prevent the exit.
 *
 * `exitImpl` is test-only DI (defaults to `process.exit`) — production never passes it.
 */
export function dispatchMergeGateDecision(
  decision: MergeGateDecision,
  recordOptions?: FireLogRecordOptions,
  exitImpl: (code: number) => never = process.exit
): never {
  recordFireLogEntry(decision.record, recordOptions);
  return exitImpl(decision.exitCode);
}

/**
 * Build a `recordAndExit` closure for a merge-gate PreToolUse hook's entry
 * point. Captures `guardName`, the invocation's start time, and the parsed
 * input's `tool_name`/`session_id` once, so every exit point in the hook's
 * body reduces to `recordAndExit("allow" | "warn" | "deny", overrideFields?)`
 * in place of a bare `process.exit(0)` — exactly mirroring the per-hook
 * `recordAndExit` closures already established in `block-git-gh-cli.ts` /
 * `check-branch-fresh.ts` / `check-task-spec-read.ts`, generalized so the ~10
 * merge-gate hooks don't each hand-roll their own copy of this ~10-line
 * closure body.
 *
 * `decision` classification convention used by every merge-gate hook wired
 * against this factory (matches `dispatcher.ts`'s derivation — see
 * `docs/architecture/evaluation-loop-fire-log.md`):
 * - a bare early exit (guard doesn't apply to this tool call, or a
 *   transport/fetch failure logged only to stderr/console.error — i.e.
 *   nothing added to the JSON `hookSpecificOutput` sent back to the caller)
 *   → `"allow"`.
 * - a `writeOutput({ hookSpecificOutput: { additionalContext, ... } })` with
 *   no `permissionDecision` → `"warn"`.
 * - a `writeOutput({ hookSpecificOutput: { permissionDecision: "deny", ... } })`
 *   → `"deny"`.
 *
 * `recordOptions` is test-only DI (mirrors `recordFireLogEntry`'s own
 * `options` param — injectable fs/logPath/env/now/stderrWrite) — production
 * call sites never pass it, so every real invocation records through the
 * real fs at the real `~/.local/state/minsky/fire-log.jsonl` path, exactly
 * like every other fire-log-instrumented standalone guard.
 *
 * As of mt#3630 this is a two-line composition of {@link makeMergeGateDecider} (pure
 * record construction) and {@link dispatchMergeGateDecision} (write + exit). The
 * signature, the record it produces, and the `never` return are unchanged — every one
 * of the ~10 guard call sites is untouched by that split, deliberately: this is the
 * merge-enforcement surface.
 */
export function makeRecordAndExit(
  guardName: string,
  startMs: number,
  input: MergeGateHookInput,
  recordOptions?: FireLogRecordOptions,
  context?: MergeGateFireLogContext
): RecordAndExit {
  const decide = makeMergeGateDecider(guardName, startMs, input, context);
  return (decision, overrideFields) =>
    dispatchMergeGateDecision(decide(decision, overrideFields), recordOptions);
}
