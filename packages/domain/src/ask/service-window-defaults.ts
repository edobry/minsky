/**
 * Per-kind service-window default matrix — mt#1411 spine (mt#1488).
 *
 * Encodes the default `serviceStrategy` and `windowKey` for each of the
 * seven ADR-008 Ask kinds. `asks.create` applies these defaults when the
 * requestor does not supply explicit service-window arguments.
 *
 * Design rationale (from ADR draft `352937f03cb481669ab9c57be181d5b8`):
 *
 * | Kind                  | Strategy        | windowKey    | Rationale                                       |
 * |-----------------------|-----------------|--------------|--------------------------------------------------|
 * | direction.decide      | scheduled       | ask-hours    | Preference-bound; operator reviews in batches    |
 * | quality.review        | scheduled       | ask-hours    | Async-OK; reviewer works in designated windows   |
 * | authorization.approve | deadline-bound  | (none)       | Time-sensitive; must not wait indefinitely       |
 * | stuck.unblock         | asap            | (none)       | Critical-path; delay compounds the block         |
 * | coordination.notify   | asap            | (none)       | Fire-and-forget; ordering matters, not timing    |
 * | capability.escalate   | asap            | (none)       | Sync-blocking; requestor is stalled waiting      |
 * | information.retrieve  | asap            | (none)       | Mostly sync; retriever responds immediately      |
 *
 * Children of mt#1411 that consume this module:
 *   - Router/reaper (mt#1490): applies strategy at dispatch time.
 *   - Cockpit render (mt#1147): shows window badge in Ask inbox.
 *   - mt#1035 noticer: guards against forceImmediate overuse.
 */

import type { AskKind } from "./types";

/** Resolved default service-window config for a given Ask kind. */
export interface ServiceWindowDefault {
  /** Routing strategy applied when the requestor supplies no override. */
  serviceStrategy: "asap" | "scheduled" | "deadline-bound";
  /**
   * Named window (e.g. `"ask-hours"`).
   * Only present when `serviceStrategy === "scheduled"`.
   */
  windowKey?: string;
}

/**
 * Per-kind default service-window matrix.
 *
 * This is the authoritative source for default values. `asks.create` reads
 * from this object; downstream consumers (Router, Cockpit) may also import
 * it directly to avoid repeating the matrix.
 *
 * All seven AskKind values are listed explicitly (no spread / fallthrough) so
 * TypeScript will error if a new kind is added to the taxonomy without a
 * corresponding entry here.
 */
export const SERVICE_WINDOW_DEFAULTS: Record<AskKind, ServiceWindowDefault> = {
  /**
   * Preference-bound choices — operator reviews in batches during ask-hours.
   * These decisions are rarely time-critical and benefit from batched review.
   */
  "direction.decide": {
    serviceStrategy: "scheduled",
    windowKey: "ask-hours",
  },

  /**
   * Output validation — reviewer works during designated review windows.
   * Async-OK by nature; deferring to ask-hours improves throughput.
   */
  "quality.review": {
    serviceStrategy: "scheduled",
    windowKey: "ask-hours",
  },

  /**
   * Policy-gate asks — time-sensitive; must not wait indefinitely.
   * deadline-bound means: route immediately, but escalate as deadline nears.
   */
  "authorization.approve": {
    serviceStrategy: "deadline-bound",
  },

  /**
   * Critical-path unblocking — route immediately, delay compounds the block.
   */
  "stuck.unblock": {
    serviceStrategy: "asap",
  },

  /**
   * Fire-and-forget notifications — ordering matters more than timing.
   */
  "coordination.notify": {
    serviceStrategy: "asap",
  },

  /**
   * Sync-blocking escalation — requestor is stalled; route immediately.
   */
  "capability.escalate": {
    serviceStrategy: "asap",
  },

  /**
   * Information retrieval — mostly sync; retriever responds immediately.
   */
  "information.retrieve": {
    serviceStrategy: "asap",
  },
};

/**
 * Look up the default service-window config for the given Ask kind.
 *
 * Returns the strategy and optional windowKey. Callers should apply these
 * as defaults only when the requestor has not supplied explicit values.
 *
 * @example
 *   const { serviceStrategy, windowKey } = getServiceWindowDefault("direction.decide");
 *   // => { serviceStrategy: "scheduled", windowKey: "ask-hours" }
 */
export function getServiceWindowDefault(kind: AskKind): ServiceWindowDefault {
  return SERVICE_WINDOW_DEFAULTS[kind];
}
