/**
 * Per-kind service-window default matrix — mt#1411 spine (mt#1488).
 *
 * Encodes the default `serviceStrategy` and `windowKey` for each of the
 * seven ADR-008 Ask kinds. `asks.create` applies these defaults when the
 * requestor does not supply explicit service-window arguments.
 *
 * ## What still consumes this, after the window retirement (mt#4421)
 *
 * ONE live consumer: `policyFirstRoute`'s Phase 3 in `router.ts`, which branches
 * on `serviceStrategy`. Nothing else acts on the values.
 *
 *   - `asap` — route normally. This is now the default for every kind whose
 *     entry used to name a window.
 *   - `deadline-bound` — still branches (suspend until the deadline is within
 *     the page threshold). Left alone here: whether `deadline` does anything at
 *     all is mt#4304's subject, explicitly out of this task's scope.
 *   - `scheduled` — the branch is still IN the router, but nothing opens a
 *     window any more, so an ask suspended against one is suspended against a
 *     door that never opens. **No default produces this value now.** A caller
 *     may still pass it explicitly; that is their call to make, and mt#4304
 *     owns the honesty of the surrounding contract.
 *
 * ## Why the two `scheduled` rows changed (mt#4421)
 *
 * The principal retired the attention-window concept on 2026-08-21 (*"Forget
 * about the windows. I don't think it's an important concept anymore."*, quoted
 * in mt#4410's spec). mt#4410 unwired the runtime — `startServiceWindowSweeper`
 * is deliberately uncalled by the daemon — and closed the window family
 * (mt#1411, mt#4363, mt#4078, mt#1545, mt#1536).
 *
 * Its scope was the daemon wiring and headers on the uncalled entry points, so
 * it never reached HERE, and this matrix kept minting asks into `ask-hours`.
 * Measured 2026-08-22: filing a `direction.decide` ask returned
 * `serviceStrategy: "scheduled"`, `windowKey: "ask-hours"`,
 * `suspendedForWindowKey: "ask-hours"` — and `direction.decide` is the kind
 * `humility.mdc §Escalation packaging` tells every agent to use for a principal
 * escalation, so this was the DEFAULT path for reaching the operator.
 *
 * The asks stayed visible throughout — `GET /api/asks` filters on
 * `routingTarget` and non-terminal state, never on `windowKey`, and the router's
 * scheduled branch runs after `pickTransport` so the target is set correctly.
 * What was wrong was the RECORD: a strategy naming a batching policy that no
 * longer exists.
 *
 * | Kind                  | Strategy        | windowKey | Rationale                                    |
 * |-----------------------|-----------------|-----------|----------------------------------------------|
 * | direction.decide      | asap            | (none)    | was scheduled/ask-hours until mt#4421        |
 * | quality.review        | asap            | (none)    | was scheduled/ask-hours until mt#4421        |
 * | authorization.approve | deadline-bound  | (none)    | Time-sensitive; unchanged (see mt#4304)      |
 * | stuck.unblock         | asap            | (none)    | Critical-path; delay compounds the block     |
 * | coordination.notify   | asap            | (none)    | Fire-and-forget; ordering matters, not timing|
 * | capability.escalate   | asap            | (none)    | Sync-blocking; requestor is stalled waiting  |
 * | information.retrieve  | asap            | (none)    | Mostly sync; retriever responds immediately  |
 *
 * The original per-kind rationale came from the mt#1411 ADR DRAFT
 * (`352937f03cb481669ab9c57be181d5b8`) — a draft for a concept now retired, so
 * it is history rather than authority. Do not restore the window rows from it.
 *
 * **Known consequence, named not fixed:** `AsksPage.tsx` builds its "cohort"
 * filter from `windowKey` (`src/cockpit/web/pages/AsksPage.tsx:558,587`). With
 * no default setting one, every ask falls into `(none)` and that control becomes
 * a single-value no-op rather than breaking visibly. Redesigning it is out of
 * this task's scope.
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
   * Was `scheduled` / `ask-hours` until mt#4421 (2026-08-22).
   *
   * This is the kind agents file a principal escalation as, so batching it into
   * a window that nothing opens made the default escalation path record a
   * batching policy that no longer exists.
   */
  "direction.decide": {
    serviceStrategy: "asap",
  },

  /**
   * Was `scheduled` / `ask-hours` until mt#4421 (2026-08-22), for the same
   * reason: the window runtime it deferred to is retired.
   */
  "quality.review": {
    serviceStrategy: "asap",
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
 *   // => { serviceStrategy: "asap" }   (was scheduled/ask-hours until mt#4421)
 */
export function getServiceWindowDefault(kind: AskKind): ServiceWindowDefault {
  return SERVICE_WINDOW_DEFAULTS[kind];
}
