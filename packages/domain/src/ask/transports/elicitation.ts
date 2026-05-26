/**
 * Elicitation transport — ADR-008 §Transport-binding matrix, mt#1457.
 *
 * Dispatches sync ask kinds via the MCP `elicitation/create` request when
 * the active client advertises elicitation capability. The transport is
 * the only place in the codebase that calls `Server.elicitInput()`; the
 * grep regression test in `elicitation.test.ts` enforces this so accidental
 * Shape A drift (callers bypassing the Ask subsystem) is detected at CI time.
 *
 * State machine: walks `detected → classified → routed → suspended` on
 * dispatch (before issuing the elicitation), then `suspended → responded
 * → closed` on accept. On user decline/cancel, transitions
 * `suspended → cancelled`. On dispatch error (timeout, host disconnect),
 * leaves the Ask in `suspended` state with `transport.kind: "elicitation"`
 * recorded — the operator CLI (mt#1458) is the recovery path.
 *
 * v1 covers `direction.decide`. Other kinds throw an "unsupported" error
 * so the caller discovers mis-routing early (rather than silently emitting
 * an elicitation with an empty/wrong schema).
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md
 */

import { log } from "@minsky/shared/logger";
import type { AttentionCost, AskKind, AgentId } from "../types";
import { assertNever } from "../types";
import type { AskRepository } from "../repository";
import type { RoutedAsk, AskPayload, TransportBinding } from "../router";
import type {
  ElicitationCapableServer,
  ElicitInputParams,
  ElicitInputResult,
} from "../../../../../src/mcp/client-capabilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default per-elicitation timeout in milliseconds. Applied to
 * `server.elicitInput()`. Override via `timeoutMs` in
 * `ElicitationTransportOptions`.
 *
 * 5 minutes balances "long enough for an operator to read + decide" against
 * "short enough that an abandoned dialog doesn't pin server resources
 * indefinitely." Tune via the option for kinds with stricter SLAs.
 */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// ElicitationClosedAsk
// ---------------------------------------------------------------------------

/**
 * Result of an elicitation dispatch.
 *
 * - `state: "closed"` on accept — operator chose; response payload populated.
 * - `state: "cancelled"` on decline/cancel — operator opted out.
 * - `state: "suspended"` on dispatch error (timeout, host disconnect) — the
 *   Ask remains observable and recoverable via the operator CLI (mt#1458).
 *
 * Defined as `Omit<RoutedAsk, "state"> & { state: ... }` (rather than
 * `RoutedAsk & { state: ... }`) because mt#1069's `RoutedAsk.state` is
 * narrowed to `"routed" | "closed"`. The elicitation transport is the one
 * place that legitimately walks the Ask into `suspended`/`cancelled`
 * terminal states post-routing — those are valid AskState values, just
 * not in the RoutedAsk subset. The Omit-then-redeclare pattern says
 * explicitly: "this is a RoutedAsk except the state has widened."
 */
export type ElicitationClosedAsk = Omit<RoutedAsk, "state"> & {
  state: "closed" | "cancelled" | "suspended";
  routingTarget: "operator";
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for `dispatchToElicitation`.
 */
export interface ElicitationTransportOptions {
  /**
   * Active MCP `Server` instance to issue elicitation against. Required.
   * The transport calls `server.elicitInput()` on this — pre-condition is
   * that the client behind this server advertises elicitation capability
   * (the router stage-1 check enforces this for the routing decision; the
   * transport accepts a server unconditionally so test fakes are simple).
   */
  server: ElicitationCapableServer;

  /**
   * Repository for persisting state-machine transitions during dispatch.
   * The transport walks `detected → classified → routed → suspended` before
   * issuing elicitation, then writes the response on accept.
   */
  repo: AskRepository;

  /**
   * Per-elicitation timeout in milliseconds.
   * @default DEFAULT_ELICITATION_TIMEOUT_MS (5 minutes)
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// dispatchToElicitation
// ---------------------------------------------------------------------------

/**
 * Dispatch a `RoutedAsk` through the elicitation transport. Walks the
 * state machine, issues `elicitation/create`, and returns an
 * `ElicitationClosedAsk` reflecting the final state.
 *
 * Only handles sync ask kinds with a defined `requestedSchema` (v1:
 * `direction.decide`). Throws for unsupported kinds so mis-routing is
 * loud, not silent.
 *
 * Error handling:
 *   - Timeout / dispatch error / host disconnect → Ask remains in
 *     `"suspended"` state with `transport.kind: "elicitation"` recorded.
 *     The operator CLI (mt#1458) is the recovery path. Returned object's
 *     state field reflects this.
 *   - User decline/cancel → Ask transitions to `"cancelled"`.
 *   - Accept → Ask transitions to `"responded"` then `"closed"`. Response
 *     payload is the elicit result content; attentionCost records the
 *     transport.
 */
export async function dispatchToElicitation(
  routedAsk: RoutedAsk,
  options: ElicitationTransportOptions
): Promise<ElicitationClosedAsk> {
  const { kind } = routedAsk;
  if (!isElicitationSupported(kind)) {
    throw new Error(
      `elicitation transport: unsupported kind "${kind}". ` +
        `v1 covers "direction.decide"; extend isElicitationSupported + buildRequestedSchema to add more.`
    );
  }

  const { server, repo, timeoutMs = DEFAULT_ELICITATION_TIMEOUT_MS } = options;

  // -----------------------------------------------------------------------
  // Walk state machine forward to "suspended" from whatever the persisted
  // current state is.
  // -----------------------------------------------------------------------
  // The persisted Ask's current state may be anywhere from "detected" (the
  // typical createAsk → policyFirstRoute → here flow, where intermediate
  // transitions are not persisted) up through "suspended" (a recovery
  // re-dispatch from operator CLI, mt#1458). We read the current state and
  // only advance through the gaps so re-entry is idempotent and we never
  // hit InvalidAskTransitionError on a legitimate caller.
  await advanceToSuspended(repo, routedAsk.id);

  // -----------------------------------------------------------------------
  // Issue elicitation/create
  // -----------------------------------------------------------------------
  const params: ElicitInputParams = {
    message: buildPrompt(routedAsk),
    requestedSchema: buildRequestedSchema(kind, routedAsk),
  };

  let result: ElicitInputResult;
  try {
    result = await server.elicitInput(params, { timeout: timeoutMs });
  } catch (err) {
    // Dispatch failed — host disconnect, timeout, transport error. Per
    // mt#1457 spec: "leave the Ask in suspended state with
    // transport.kind: 'elicitation' recorded." The repo already shows
    // state=suspended from the walk above; we just shape the return.
    // Log the error so it isn't silently lost (PR #919 R3 — the suspended
    // return object intentionally has no `response` field).
    log.warn("elicitation transport: dispatch failed; leaving Ask suspended", {
      askId: routedAsk.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return buildSuspendedClose(routedAsk, err);
  }

  // -----------------------------------------------------------------------
  // Process result
  // -----------------------------------------------------------------------
  if (result.action !== "accept") {
    // User declined or cancelled — transition to "cancelled" terminal state.
    // Log the action since the cancelled return object has no `response`
    // field (PR #919 R3 — invariant: response only on responded/closed).
    log.debug("elicitation transport: operator declined/cancelled", {
      askId: routedAsk.id,
      action: result.action,
    });
    await repo.transition(routedAsk.id, "cancelled");
    return buildCancelledClose(routedAsk);
  }

  // Accept — write response, transition to "responded", then "closed".
  const responsePayload = {
    responder: "operator" as const,
    payload: (result.content ?? {}) as Record<string, unknown>,
    attentionCost: buildAttentionCost(),
  };

  await repo.respond(routedAsk.id, { response: responsePayload });
  await repo.close(routedAsk.id, { response: responsePayload });

  return buildAcceptedClose(routedAsk, result.content, responsePayload.attentionCost);
}

// ---------------------------------------------------------------------------
// State machine helpers
// ---------------------------------------------------------------------------

/**
 * Walk a persisted Ask forward to `"suspended"` from whatever its current
 * state is. Idempotent: if the Ask is already at `"suspended"`, this is a
 * no-op. Throws if the persisted state is past `"suspended"` (responded /
 * closed / cancelled / expired) — those are caller errors (re-dispatching
 * a terminal Ask is invalid).
 *
 * Transition table (from `state-machine.ts`):
 *   detected → classified → routed → suspended
 */
async function advanceToSuspended(repo: AskRepository, askId: string): Promise<void> {
  const persisted = await repo.getById(askId);
  if (!persisted) {
    throw new Error(`elicitation transport: Ask not found: ${askId}`);
  }

  switch (persisted.state) {
    case "detected":
      await repo.transition(askId, "classified");
      await repo.transition(askId, "routed");
      await repo.transition(askId, "suspended");
      return;
    case "classified":
      await repo.transition(askId, "routed");
      await repo.transition(askId, "suspended");
      return;
    case "routed":
      await repo.transition(askId, "suspended");
      return;
    case "suspended":
      // Already at the target state — no-op for re-dispatch / recovery.
      return;
    case "responded":
    case "closed":
    case "cancelled":
    case "expired":
      throw new Error(
        `elicitation transport: cannot dispatch Ask in terminal/post-suspended state "${persisted.state}" — re-dispatch is invalid`
      );
    default:
      // Exhaustiveness guard via assertNever pattern would require importing
      // it; the explicit case list above covers all 8 AskState values, and
      // adding a new state would surface here as a missing case at runtime
      // (caught by tests) and as a compile error at the switch statement.
      throw new Error(`elicitation transport: unhandled Ask state "${persisted.state}"`);
  }
}

// ---------------------------------------------------------------------------
// Kind support and requestedSchema builders
// ---------------------------------------------------------------------------

/**
 * Sync kinds that v1 supports through elicitation. Each must have a
 * matching entry in `buildRequestedSchema`. Adding a new kind requires
 * extending both functions; the exhaustive switch + `assertNever` enforces
 * this at compile time.
 */
function isElicitationSupported(kind: AskKind): boolean {
  switch (kind) {
    case "direction.decide":
      return true;
    case "capability.escalate":
    case "information.retrieve":
    case "authorization.approve":
    case "coordination.notify":
    case "quality.review":
    case "stuck.unblock":
      return false;
    default:
      return assertNever(kind);
  }
}

/**
 * Build the JSON Schema (form mode) describing the response shape.
 *
 * v1 supports only `direction.decide`. The schema is the flat-object
 * subset the MCP elicitation spec requires (primitive properties, no
 * nested objects/arrays at the top level).
 */
function buildRequestedSchema(kind: AskKind, ask: RoutedAsk): Record<string, unknown> {
  switch (kind) {
    case "direction.decide": {
      // For `direction.decide`, the response identifies which option the
      // operator chose (by `value`) and an optional `rationale`. When the
      // Ask carries explicit `options`, narrow `chosen` to an enum so the
      // host renders a picker; otherwise fall back to a free-text string.
      const options = ask.options ?? [];
      const chosenSchema =
        options.length > 0
          ? {
              type: "string",
              title: "Chosen option",
              description: "The value of the selected option",
              enum: options.map((o) => String(o.value)),
              enumNames: options.map((o) => o.label),
            }
          : {
              type: "string",
              title: "Chosen option",
              description: "Identifier or short description of the chosen option",
            };

      return {
        type: "object",
        properties: {
          chosen: chosenSchema,
          rationale: {
            type: "string",
            title: "Rationale",
            description: "Optional rationale for the choice",
          },
        },
        required: ["chosen"],
      };
    }
    case "capability.escalate":
    case "information.retrieve":
    case "authorization.approve":
    case "coordination.notify":
    case "quality.review":
    case "stuck.unblock":
      throw new Error(
        `buildRequestedSchema: unsupported kind "${kind}" — v1 covers direction.decide only`
      );
    default:
      return assertNever(kind);
  }
}

/**
 * Build the prompt message shown to the operator. Concatenates the Ask's
 * question with any context refs as bullet points — same shape as the
 * subagent transport (mt#1070) for prompt-construction parity.
 */
function buildPrompt(ask: RoutedAsk): string {
  const parts: string[] = [ask.question];

  if (ask.contextRefs && ask.contextRefs.length > 0) {
    parts.push("\nContext:");
    for (const ref of ask.contextRefs) {
      const desc = ref.description ? ` — ${ref.description}` : "";
      parts.push(`- ${ref.kind}: ${ref.ref}${desc}`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Response packagers
// ---------------------------------------------------------------------------

/**
 * Attention cost recorded for an elicitation-resolved Ask. The operator
 * was reached, so `operatorCost` would normally be populated; v1 leaves it
 * absent because we lack a measurement signal beyond wall-clock (the
 * elicitInput latency includes both rendering + operator decision time).
 * Future work can record the wall-clock delta as an estimate.
 */
function buildAttentionCost(): AttentionCost {
  return {
    transport: "elicitation",
    resolvedIn: "elicitation",
  };
}

function buildAcceptedClose(
  routedAsk: RoutedAsk,
  content: Record<string, unknown> | undefined,
  attentionCost: AttentionCost
): ElicitationClosedAsk {
  const now = new Date().toISOString();
  const transport: TransportBinding = { kind: "elicitation" };
  const packagedPayload: AskPayload = {
    question: routedAsk.question,
    options: routedAsk.options,
    contextRefs: routedAsk.contextRefs,
  };

  const result: ElicitationClosedAsk = {
    ...routedAsk,
    state: "closed",
    routingTarget: "operator",
    transport,
    packagedPayload,
    routedAt: routedAsk.routedAt ?? now,
    suspendedAt: routedAsk.suspendedAt ?? now,
    respondedAt: now,
    closedAt: now,
    response: {
      responder: "operator",
      payload: content ?? {},
      attentionCost,
    },
  };
  return result;
}

/**
 * Build the cancelled-state return object.
 *
 * Per `Ask.response`'s contract in `types.ts`, `response` is only present
 * when `state` is `"responded"` or `"closed"`. Cancelled is a terminal
 * state with NO response — the operator opted out before resolving the
 * Ask. Omitting `response` here matches what the repository persists
 * after `repo.transition(id, "cancelled")` and avoids the in-memory /
 * persisted divergence the reviewer flagged on PR #919 R3.
 *
 * Callers can still distinguish decline-vs-cancel by inspecting the
 * `state` field (always "cancelled" here) — the granularity is logged
 * in `dispatchToElicitation` but not returned in-band, since "the user
 * opted out" is the load-bearing signal for downstream consumers.
 */
function buildCancelledClose(routedAsk: RoutedAsk): ElicitationClosedAsk {
  const now = new Date().toISOString();
  const transport: TransportBinding = { kind: "elicitation" };
  const packagedPayload: AskPayload = {
    question: routedAsk.question,
    options: routedAsk.options,
    contextRefs: routedAsk.contextRefs,
  };

  const result: ElicitationClosedAsk = {
    ...routedAsk,
    state: "cancelled",
    routingTarget: "operator",
    transport,
    packagedPayload,
    routedAt: routedAsk.routedAt ?? now,
    suspendedAt: routedAsk.suspendedAt ?? now,
    closedAt: now,
    // Intentionally no `response` — see function docstring.
  };
  return result;
}

/**
 * Build the suspended-state return object (dispatch error / disconnect).
 *
 * Per `Ask.response`'s contract in `types.ts`, `response` is only present
 * for `"responded"` / `"closed"`. Suspended is the waiting-for-resolution
 * state — no response yet. Omitting `response` here matches the
 * repository's persistence after `repo.transition(id, "suspended")`.
 *
 * The dispatch error message is intentionally not returned in-band; if
 * future operator UX needs to surface "what failed" to the recovery
 * flow (mt#1458), the right path is logging or an extension to
 * `Ask.metadata`, not a phantom `response` field. PR #919 R3 BLOCKING.
 */
function buildSuspendedClose(routedAsk: RoutedAsk, _err: unknown): ElicitationClosedAsk {
  const now = new Date().toISOString();
  const transport: TransportBinding = { kind: "elicitation" };
  const packagedPayload: AskPayload = {
    question: routedAsk.question,
    options: routedAsk.options,
    contextRefs: routedAsk.contextRefs,
  };

  const result: ElicitationClosedAsk = {
    ...routedAsk,
    state: "suspended",
    routingTarget: "operator",
    transport,
    packagedPayload,
    routedAt: routedAsk.routedAt ?? now,
    suspendedAt: routedAsk.suspendedAt ?? now,
    // Intentionally no `response` — see function docstring.
  };
  return result;
}

// ---------------------------------------------------------------------------
// Test-only re-exports for test files
// ---------------------------------------------------------------------------

/**
 * Test-only export: the unwrapped sync-kind support check. Lets tests
 * verify the kind allowlist without dispatching.
 */
export const _testOnly = {
  isElicitationSupported,
  buildRequestedSchema,
  buildPrompt,
};

// Re-export the AgentId type so consumers don't need a separate import.
export type { AgentId };
