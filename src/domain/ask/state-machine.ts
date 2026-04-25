/**
 * Ask state-machine transition table and guard.
 *
 * All valid (from → to) pairs live in VALID_TRANSITIONS. The `guardTransition`
 * function enforces the table and throws a clear error on invalid moves.
 * `assertNever` is used in the switch so adding a new AskState without
 * updating this file causes a compile-time error.
 *
 * Lifecycle (in order):
 *   detected → classified → routed → suspended → responded → closed
 *
 * Terminal states (closed, cancelled, expired) can only be reached from
 * specific non-terminal states; once terminal, no further transitions are
 * allowed.
 *
 * Reference: docs/architecture/adr-006-attention-allocation-subsystem.md
 */

import type { AskState } from "./types";
import { assertNever } from "./types";

/**
 * Valid state transitions as a map from `from` → set of allowed `to` states.
 *
 * Each case in the switch below must be exhaustive over AskState so that
 * adding a new state triggers a compile error at the `assertNever` call.
 */
function buildValidTransitions(): ReadonlyMap<AskState, ReadonlySet<AskState>> {
  const map = new Map<AskState, ReadonlySet<AskState>>();

  // Helper to register allowed next-states for a given current state.
  function allow(from: AskState, ...to: AskState[]): void {
    map.set(from, new Set(to));
  }

  // Exhaustive switch forces a compile error when a new AskState is added.
  const states: AskState[] = [
    "detected",
    "classified",
    "routed",
    "suspended",
    "responded",
    "closed",
    "cancelled",
    "expired",
  ];

  for (const state of states) {
    switch (state) {
      case "detected":
        // Classifier runs → classified; or operator/policy short-circuits to cancelled/expired.
        allow(state, "classified", "cancelled", "expired");
        break;
      case "classified":
        // Router picks a target → routed; or short-circuit close paths.
        allow(state, "routed", "cancelled", "expired");
        break;
      case "routed":
        // Transport dispatched → suspended (waiting for response).
        allow(state, "suspended", "cancelled", "expired");
        break;
      case "suspended":
        // Response received → responded; or deadline/cancel.
        allow(state, "responded", "cancelled", "expired");
        break;
      case "responded":
        // Post-response validation/side-effects complete → closed.
        allow(state, "closed", "cancelled");
        break;
      case "closed":
        // Terminal — no further transitions.
        allow(state);
        break;
      case "cancelled":
        // Terminal — no further transitions.
        allow(state);
        break;
      case "expired":
        // Terminal — no further transitions.
        allow(state);
        break;
      default:
        // Exhaustiveness guard: adding a new AskState without handling it here
        // causes a TypeScript error at the assertNever call.
        return assertNever(state);
    }
  }

  return map;
}

/** Immutable transition table built once at module load. */
export const VALID_TRANSITIONS: ReadonlyMap<
  AskState,
  ReadonlySet<AskState>
> = buildValidTransitions();

/**
 * Assert that the requested `from → to` transition is permitted.
 *
 * Throws an `InvalidAskTransitionError` with a descriptive message when the
 * transition is not in the table. Returns `to` on success so callers can use
 * it in a pipeline.
 */
export function guardTransition(from: AskState, to: AskState): AskState {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new InvalidAskTransitionError(from, to);
  }
  return to;
}

/**
 * Returns true iff `state` is a terminal AskState (no further transitions
 * are ever allowed).
 */
export function isTerminal(state: AskState): boolean {
  const allowed = VALID_TRANSITIONS.get(state);
  return !allowed || allowed.size === 0;
}

/**
 * Thrown when an Ask transition is attempted that is not in the valid
 * transition table.
 */
export class InvalidAskTransitionError extends Error {
  readonly from: AskState;
  readonly to: AskState;

  constructor(from: AskState, to: AskState) {
    super(`Invalid Ask transition: "${from}" → "${to}"`);
    this.name = "InvalidAskTransitionError";
    this.from = from;
    this.to = to;
  }
}
