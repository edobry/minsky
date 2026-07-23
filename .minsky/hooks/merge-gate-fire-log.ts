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
// `writeOutput({...}); process.exit(0);` exit points (deny, or an
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
}

/** The `recordAndExit` closure shape every merge-gate hook's entry point uses. */
export type RecordAndExit = (
  decision: FireLogDecision,
  overrideFields?: MergeGateOverrideFields
) => never;

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
 */
export function makeRecordAndExit(
  guardName: string,
  startMs: number,
  input: MergeGateHookInput,
  recordOptions?: FireLogRecordOptions
): RecordAndExit {
  return (decision, overrideFields) => {
    recordFireLogEntry(
      {
        guardName,
        event: "PreToolUse",
        decision,
        durationMs: Date.now() - startMs,
        toolName: input.tool_name,
        sessionId: input.session_id,
        ...overrideFields,
      },
      recordOptions
    );
    process.exit(0);
  };
}
