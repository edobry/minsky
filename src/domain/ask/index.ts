/**
 * Ask subsystem — ADR-006 (mt#1034).
 *
 * Unified domain types, state machine, and repository for all human-in-the-loop
 * mechanisms in Minsky. Router lands in a separate task.
 */

export type {
  AgentId,
  AskKind,
  AskState,
  AskOption,
  ContextRef,
  AttentionCost,
  TransportKind,
  Ask,
} from "./types";

export { assertNever } from "./types";

// State machine
export {
  VALID_TRANSITIONS,
  guardTransition,
  isTerminal,
  InvalidAskTransitionError,
} from "./state-machine";

// Repository interface + implementations
export type { AskRepository, CreateAskInput, CloseAskInput } from "./repository";
export { DrizzleAskRepository, FakeAskRepository } from "./repository";
