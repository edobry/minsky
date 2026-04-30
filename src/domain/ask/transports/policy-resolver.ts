/**
 * Policy-resolver transport helper.
 *
 * Encapsulates the "close with policy" operation: given an Ask and a policy
 * citation, produce a ClosedAsk with state="closed", routingTarget="policy",
 * and the citation in the response payload.
 *
 * This is Phase 1 of the router's two-phase decision (ADR-008 §Router).
 * The router calls `closeWithPolicy` after `isCovered` returns a citation;
 * transport adapters for inbox/AG-UI/mesh/subagent are separate (mt#454,
 * mt#700, mt#1001, mt#1070).
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 */

import type { Ask } from "../types";
import type { PolicyCitation } from "../policy";
import type { RoutedAsk, AskPayload, TransportBinding } from "../router";
import { buildAttentionCost } from "../accounting/index";

// ---------------------------------------------------------------------------
// ClosedAsk
// ---------------------------------------------------------------------------

/**
 * A ClosedAsk is a RoutedAsk where the router decided policy covers the action
 * and no further transport dispatch is needed.
 *
 * The caller may use RoutedAsk directly (the discriminant is state="closed"
 * combined with routingTarget="policy"). This alias exists as documentation.
 */
export type ClosedAsk = RoutedAsk & {
  state: "closed";
  routingTarget: "policy";
};

// ---------------------------------------------------------------------------
// closeWithPolicy
// ---------------------------------------------------------------------------

/**
 * Produce a closed RoutedAsk from a policy citation.
 *
 * Sets:
 *   - `state`: "closed"
 *   - `routingTarget`: "policy"
 *   - `transport`: `{ kind: "policy" }`
 *   - `packagedPayload`: citation included
 *   - `response.responder`: "policy"
 *   - `response.payload`: `{ citation }`
 *   - `response.attentionCost`: computed via buildAttentionCost (tokenCost=0, transport="policy")
 *   - `closedAt`: now (ISO-8601)
 *   - `routedAt`: now (ISO-8601)
 *
 * All other Ask fields are forwarded unchanged.
 *
 * Throws if buildAttentionCost throws — policy resolves do not swallow errors.
 */
export function closeWithPolicy(ask: Ask, citation: PolicyCitation): ClosedAsk {
  const now = new Date().toISOString();

  const transport: TransportBinding = { kind: "policy" };

  const packagedPayload: AskPayload = {
    question: ask.question,
    options: ask.options,
    contextRefs: ask.contextRefs,
    citation,
  };

  // Policy close has no LLM token cost (policy lookup is deterministic).
  // buildAttentionCost returns { tokenCost: 0, transport: "policy", resolvedIn: "policy" }.
  const attentionCost = buildAttentionCost({ responder: "policy" });

  return {
    ...ask,
    state: "closed",
    routingTarget: "policy",
    transport,
    packagedPayload,
    routedAt: now,
    closedAt: now,
    response: {
      responder: "policy",
      payload: { citation },
      attentionCost,
    },
  };
}
