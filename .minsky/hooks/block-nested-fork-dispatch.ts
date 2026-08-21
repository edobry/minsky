#!/usr/bin/env bun
// PreToolUse hook: deny an UNDECLARED nested `fork` dispatch — a subagent
// (agent_id present) calling the Agent tool with `subagent_type: "fork"`
// while no live dispatch-intent declaration covers its session (mt#3045).
//
// ## Why this exists
//
// mt#2865 (DONE) shipped `dispatch-intent-write-gate.ts` as the structural
// fix for fork-scope-creep — a context-inheriting fork writing to the
// shared substrate. But that gate is OPT-IN: it only contains a fork whose
// dispatch DECLARED `intent: "read-only"` via `session.generate_prompt` /
// `tasks.dispatch` BEFORE the fork was created. A fork dispatched via the
// raw Agent tool with no such declaration bypasses it entirely.
//
// On 2026-07-21 (memory `bed551ef` / mem#665, R2 recurrence) this happened:
// mt#3014's implementer subagent dispatched a fork for a bounded read-only
// lookup ("is this test flake known?") WITHOUT declaring read-only intent.
// The gate never applied. The fork inherited the full implementation
// context and made 2 unrequested commits to the shared session branch.
// Outcome was benign (content converged, PR #2157 reviewed clean), but it
// is a DONE-but-recurred containment failure of the shipped fix.
//
// This guard closes the gap one layer EARLIER than the write gate: instead
// of containing the fork's writes AFTER it exists, it denies the fork's
// CREATION when it is a NESTED dispatch (a subagent dispatching another
// subagent) carrying no live dispatch-intent declaration. Per
// `subagent-routing.mdc`, a bounded lookup from inside an active
// implementation context should use `Explore` / `general-purpose` instead
// of a fork; when a fork genuinely is the right shape, the orchestrating
// subagent is expected to declare `intent: "read-only"` first — this guard
// makes that expectation structural instead of advisory.
//
// ## Detection: is this a NESTED dispatch?
//
// `ToolHookInput.agent_id` is populated by the harness whenever the tool
// call originates from a DISPATCHED subagent (not the main thread) — the
// exact mechanism `dispatch-intent-write-gate.ts`'s `isSubagentContext` and
// `block-subagent-merge-without-grant.ts`'s `isSubagentContext` already rely
// on in production. A fork dispatch made BY the main agent (top-level,
// `agent_id` absent) is NOT nested and is unaffected by this guard — only a
// subagent-calling-the-Agent-tool-for-a-fork (nested) is gated.
//
// ## Policy
//
// - **Only `subagent_type: "fork"` is gated.** Nested dispatch of any other
//   subagent type (Explore, general-purpose, auditor, reviewer, ...) is
//   unaffected — those don't inherit the full conversation context the way
//   a fork does, so they are not the mechanism this incident class exploits.
// - **Only NESTED dispatch is gated.** A top-level fork dispatch from the
//   main agent (`agent_id` absent) is unaffected.
// - **Deny when:** nested + fork + no live dispatch-intent declaration
//   (read-only OR implementation — either counts as "the orchestrator
//   explicitly thought about this before dispatching") covers the calling
//   subagent's session.
// - **Allow when:** a live declaration covers the session (the sanctioned
//   path — declare `intent: "read-only"` via `session.generate_prompt` /
//   `tasks.dispatch` before forking), OR the `MINSKY_ALLOW_NESTED_FORK`
//   override is set (launch-time-env-only escape valve for a genuinely
//   write-capable nested dispatch a human has explicitly authorized).
//
// ## Session-id resolution
//
// The Agent tool's `tool_input` carries no `sessionId` param (it takes
// `prompt` / `subagent_type` / `description` / ...), so resolution always
// falls through to parsing `input.cwd` — reusing
// `dispatch-intent-write-gate.ts`'s `resolveSessionIdFromInput` exactly
// (no duplicated logic; a subagent's cwd, when it is operating inside a
// session workspace, literally IS the session directory).
//
// ## Fail-open posture
//
// Fail-open is reserved for GENUINE ERRORS reading the dispatch-intent
// store (file unreadable for reasons other than "doesn't exist yet",
// malformed JSON) — mirrors `dispatch-intent-write-gate.ts` exactly. A
// CONFIRMED "no declarations" state is this guard's ordinary DENY path (the
// inverse of the write gate's ordinary ALLOW path — this guard's default
// posture is "an undeclared nested fork is denied," not "allowed").
//
// ## Known limitation (same harness-capability boundary as mt#2865)
//
// This guard denies the fork's CREATION via the Agent tool's PreToolUse
// hook — it cannot, and does not attempt to, stop a fork from THINKING
// like an implementer once dispatched (a harness context-scoping
// capability outside Minsky's control; see mt#2512/mt#2521). A fork
// dispatched WITH a live declaration still inherits the full conversation
// context; what changes is that (a) its creation is no longer silently
// unguarded, and (b) `dispatch-intent-write-gate.ts` is now guaranteed live
// for its writes whenever the declaration is `"read-only"`, since the two
// guards read the exact same store.
//
// @see mt#3045 — this guard's tracking task
// @see mt#2865 — the write-gate this guard complements (opt-in containment)
// @see memory bed551ef / mem#665 — the R2 recurrence this guard closes
// @see .minsky/hooks/dispatch-intent-write-gate.ts — sibling guard, isSubagentContext / resolveSessionIdFromInput source
// @see .minsky/hooks/dispatch-intent-store.ts — declaration schema + matching logic
// @see .minsky/rules/subagent-routing.mdc — the advisory guidance this guard makes structural
// @see .minsky/rules/hook-files.mdc "Nested-Fork Dispatch Guard"

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import { getDispatchIntentStorePath, readDispatchIntentStore } from "./dispatch-intent-store";
import {
  GATED_SUBAGENT_TYPE,
  OVERRIDE_ENV_VAR,
  decideNestedForkDispatchGate,
} from "@minsky/domain/detectors/nested-fork-dispatch-gate";
import type { NestedForkDispatchGateDecision } from "@minsky/domain/detectors/nested-fork-dispatch-gate";
import type { DispatchIntentDeclaration } from "@minsky/domain/detectors/dispatch-intent-gate";
import { isSubagentContext, resolveSessionIdFromInput } from "./dispatch-intent-write-gate";
import { makeRecordAndExit, type RecordAndExit } from "./merge-gate-fire-log";
import { classifyOverride } from "./fire-log";

/** This guard's fire-log identifier (mt#3084, evaluation-loop Phase 3). */
const GUARD_NAME = "block-nested-fork-dispatch";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `GATED_SUBAGENT_TYPE` and `OVERRIDE_ENV_VAR` moved to the domain module with
// the decision (mt#4374) and are re-exported here so this module's consumers
// and its own binding tests keep one import path. `OVERRIDE_ENV_VAR` is a
// launch-time-env-only override: set it to allow a nested fork dispatch to
// proceed with no live dispatch-intent declaration. It mirrors the
// `MINSKY_FORCE_*` convention used by sibling guards (e.g.
// `MINSKY_FORCE_PARALLEL`) and must be set before the harness process starts —
// there is no mid-session grant surface for this guard (unlike the D8 guard
// family), since the decision it gates (create a nested fork at all) is a
// one-shot, dispatch-time choice, not a repeated write.
export { GATED_SUBAGENT_TYPE, OVERRIDE_ENV_VAR };

// ---------------------------------------------------------------------------
// Pure detection helpers (exported for testing)
// ---------------------------------------------------------------------------

/** True when the Agent-tool call's `tool_input.subagent_type` is `"fork"`. */
export function isForkDispatch(input: ToolHookInput): boolean {
  return input.tool_input?.["subagent_type"] === GATED_SUBAGENT_TYPE;
}

/** True when the override env var is set to a truthy value ("1"). */
export function isOverrideActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OVERRIDE_ENV_VAR] === "1";
}

// ---------------------------------------------------------------------------
// The decision — `decideNestedForkDispatchGate`, its denial text, and the
// intent-agnostic declaration lookup underneath it — lives in
// `packages/domain/src/detectors/nested-fork-dispatch-gate.ts` (mt#4374's first
// extraction wave). Everything above this line is what the binding owns:
// reading `subagent_type` out of the payload, and reading the override out of
// the environment. Those two are exactly the arguments the decision used to
// take as a `ToolHookInput` and a defaulted `env` — the shape ADR-026 rule 2
// forbids, and the reason this guard was picked for the wave.
// ---------------------------------------------------------------------------

/**
 * Gather the facts the decision needs from this invocation, then relay the
 * verdict. Exported so the binding tests can walk payload → decision without
 * spawning the hook.
 */
export function decideFromPayload(
  input: ToolHookInput,
  declarations: DispatchIntentDeclaration[],
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env
): NestedForkDispatchGateDecision {
  return decideNestedForkDispatchGate({
    isForkDispatch: isForkDispatch(input),
    isSubagentContext: isSubagentContext(input),
    overrideActive: isOverrideActive(env),
    sessionId: resolveSessionIdFromInput(input),
    declarations,
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();
  // mt#3084 (evaluation-loop Phase 3): fire-log every evaluation, exactly
  // once per invocation regardless of which exit fires below.
  const recordAndExit: RecordAndExit = makeRecordAndExit(GUARD_NAME, startMs, input);

  if (!isForkDispatch(input) || !isSubagentContext(input)) {
    recordAndExit("allow");
  }

  const storeResult = readDispatchIntentStore(getDispatchIntentStorePath());
  if (storeResult.status === "error") {
    // Fail-open ONLY on genuine dispatch-intent-store read errors — a broken
    // store must not silently deny every nested fork dispatch.
    console.error(
      `[block-nested-fork-dispatch] warn: dispatch-intent store read error (${storeResult.message}) ` +
        "— failing open (allowing this call)."
    );
    // mt#3920: `crashed` — this allow is a fail-open on a broken store read, not a verdict.
    recordAndExit("allow", undefined, "crashed");
  }

  const decision = decideFromPayload(input, storeResult.declarations, Date.now());

  if (decision.decision === "allow") {
    // mt#3084: the OVERRIDE_ENV_VAR branch inside decideNestedForkDispatchGate
    // is distinguishable only via its `reason` string (the function's return
    // type carries no separate discriminator, and adding one would touch the
    // gate's decision logic — out of scope per this task's hard constraints).
    // String-matching the documented "<VAR> override active" reason is
    // read-only instrumentation: it changes nothing about what was decided.
    const overrideFields = decision.reason.includes(`${OVERRIDE_ENV_VAR} override active`)
      ? {
          overrideEnvVar: OVERRIDE_ENV_VAR,
          overrideClassification: classifyOverride(OVERRIDE_ENV_VAR),
        }
      : undefined;
    // mt#3920: `decided` only when the gate actually reached its verdict. An OVERRIDE
    // allow is left UNSET — the guard did not run, so it is evidence of neither a clean
    // decision nor a crash (dispatcher.ts records overrides the same way).
    recordAndExit("allow", overrideFields, overrideFields ? undefined : "decided");
  }

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
  recordAndExit("deny", undefined, "decided");
}
