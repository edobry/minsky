/**
 * Decision: should a NESTED `fork` dispatch be denied for want of a live
 * dispatch-intent declaration? (mt#3045)
 *
 * Lifted from `.minsky/hooks/block-nested-fork-dispatch.ts` by mt#4374's first
 * extraction wave.
 *
 * WHAT THE EXTRACTION FIXED. The hook's `decideNestedForkDispatchGate` ended
 * `env: NodeJS.ProcessEnv = process.env` — a dependency parameter carrying a
 * default value, which ADR-026 rule 2 forbids in as many words ("no `?`, no
 * default value"). The obvious repair is to make it required. The right one is
 * to REMOVE it: reading an override env var is fact-gathering, which belongs to
 * the binding, so what the verdict needs is the ANSWER (`overrideActive`), not
 * the environment to look it up in. The same holds for the two payload
 * predicates it called — `isForkDispatch` and `isSubagentContext` are trigger
 * matching over a hook payload, which is also the binding's job.
 *
 * What is left takes plain values and needs no `deps` at all. That is the
 * general result, not a quirk of this guard: `deps` injects the things a
 * function must REACH, and a verdict that has had its fact-gathering hoisted
 * into the binding reaches nothing.
 *
 * ADR-026 tier 2: no dependencies, no `deps` parameter, no `process.env` read,
 * no filesystem access, no clock read.
 *
 * @see docs/architecture/adr-026-dependency-injection-convention.md — rule 2
 * @see docs/architecture/hooks/nested-fork-dispatch-guard.md
 * @see subagent-routing.mdc — the advisory guidance this guard makes structural
 * @see mt#4374 — the extraction wave
 */
import { hasLiveDeclaration, type DispatchIntentDeclaration } from "./dispatch-intent-gate";

/**
 * The gated `subagent_type` value — only nested `fork` dispatches are denied.
 *
 * Consumed EXTERNALLY, not here: this module's decision takes the already-computed
 * `isForkDispatch` boolean, so the comparison against this value happens in the binding
 * (`.minsky/hooks/block-nested-fork-dispatch.ts`'s `isForkDispatch`). It lives here rather than
 * in the binding because WHICH subagent type is gated is part of the rule, not part of reading a
 * payload — the same split `PR_CREATE_TOOL_NAME` sits on in `pr-convergence-reminder.ts`. Do not
 * remove it as an unused export.
 */
export const GATED_SUBAGENT_TYPE = "fork";

/**
 * Launch-time-env-only override the binding reads on this guard's behalf.
 *
 * Also consumed externally (the binding reads the variable; this module only names it and quotes
 * it back in the allow-reason so the fire-log records WHY a call went through).
 */
export const OVERRIDE_ENV_VAR = "MINSKY_ALLOW_NESTED_FORK";

export const DENY_REASON_PREFIX =
  "Nested fork dispatch denied (mt#3045 nested-fork-dispatch guard):";

/** The denial text shown to a subagent whose nested fork was blocked. */
export function buildNestedForkDenialMessage(sessionId: string | null): string {
  const sessionRef = sessionId ?? "this session";
  return (
    `${DENY_REASON_PREFIX} a subagent operating in ${sessionRef} attempted to dispatch a ` +
    "`fork` (which inherits the FULL conversation context) with no live dispatch-intent " +
    "declaration for this session. Per subagent-routing.mdc, use `Explore` or " +
    "`general-purpose` for a bounded read-only lookup instead of a fork. If a fork genuinely " +
    "is the right shape, call `session.generate_prompt` (or `tasks.dispatch`) with " +
    '`intent: "read-only"` for this session BEFORE dispatching the fork — that declaration ' +
    "both satisfies this guard and structurally contains the fork's writes via " +
    "dispatch-intent-write-gate.ts."
  );
}

/**
 * What the decision needs to know about a dispatch. Every field is something
 * the binding has already established from the payload or the environment —
 * deliberately not the payload itself.
 */
export interface NestedForkDispatchGateInput {
  /** The Agent-tool call's `subagent_type` is `"fork"`. */
  isForkDispatch: boolean;
  /** The caller is itself a subagent (a non-empty `agent_id`), so this is NESTED. */
  isSubagentContext: boolean;
  /** The launch-time override env var is set. */
  overrideActive: boolean;
  /** Resolved session id for the current call, or null if unresolvable. */
  sessionId: string | null;
  /** Declarations already read from the store. */
  declarations: DispatchIntentDeclaration[];
  /** Current time in epoch ms, supplied by the caller. */
  nowMs: number;
}

export type NestedForkDispatchGateDecision =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string };

/** The verdict. */
export function decideNestedForkDispatchGate(
  input: NestedForkDispatchGateInput
): NestedForkDispatchGateDecision {
  if (!input.isForkDispatch) {
    return { decision: "allow", reason: "not a fork dispatch — unaffected" };
  }
  if (!input.isSubagentContext) {
    return { decision: "allow", reason: "top-level dispatch (no agent_id) — not nested" };
  }
  if (input.overrideActive) {
    return { decision: "allow", reason: `${OVERRIDE_ENV_VAR} override active` };
  }

  if (hasLiveDeclaration(input.declarations, input.sessionId, input.nowMs)) {
    return {
      decision: "allow",
      reason: `live dispatch-intent declaration covers session=${input.sessionId ?? "?"} — dispatch permitted`,
    };
  }

  return { decision: "deny", reason: buildNestedForkDenialMessage(input.sessionId) };
}
