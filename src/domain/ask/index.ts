/**
 * Ask subsystem — ADR-006 (mt#1034).
 *
 * Unified domain types for all human-in-the-loop mechanisms in Minsky.
 * Types-only at v1; persistence, CRUD, and router land in child tasks.
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
