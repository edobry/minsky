/**
 * Subagent-dispatch transport — ADR-008 §Transport-binding matrix rows:
 *   capability.escalate  → Subagent (Opus / specialist)
 *   stuck.unblock        → Opus → peer-agent via mesh → Inbox → operator
 *
 * v1 scope:
 *   - capability.escalate: full dispatch to requested subagent model/type.
 *   - stuck.unblock: step 1 only (Opus dispatch). Steps 2-4 (mesh peer,
 *     Inbox, operator) are blocked on mt#1001 and mt#454 landing.
 *     TODO(mt#1001, mt#454): extend chain walker once those tasks land.
 *
 * Dispatch itself is delegated to a `SubagentDispatcher` interface so
 * the transport can be tested with a mock and can be replaced by the
 * native Task-tool integration once mt#441 ships.
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md
 */

import type { AgentId } from "../types";
import type { RoutedAsk, AskPayload, TransportBinding } from "../router";
import { buildAttentionCost } from "../accounting/index";

// ---------------------------------------------------------------------------
// SubagentDispatcher interface (DI seam)
// ---------------------------------------------------------------------------

/**
 * Model identifier for subagent dispatch.
 *
 * v1 values used by the transport:
 *   "opus"   — Anthropic Claude Opus (highest reasoning, highest cost)
 *   "sonnet" — Anthropic Claude Sonnet (balanced)
 *   "haiku"  — Anthropic Claude Haiku (fast, cheap)
 *
 * Treated as an open string so callers can pass provider-specific IDs.
 */
export type SubagentModel = "opus" | "sonnet" | "haiku" | string;

/**
 * The minimal context passed to a subagent invocation.
 *
 * Future: add `scope`, `contextRefs`, `sessionId`, `parentTaskId` once
 * the Task-tool integration (mt#441) defines its contract.
 */
export interface SubagentRequest {
  /** Target model. */
  model: SubagentModel;
  /**
   * Agent type hint — controls which skill harness is used.
   * Maps to `session_generate_prompt`'s `type` parameter.
   */
  type: "general-purpose" | "refactorer" | "auditor" | "reviewer" | string;
  /** Full prompt to send to the subagent. */
  prompt: string;
}

/**
 * Response from a subagent invocation.
 */
export interface SubagentResponse {
  /** The subagent's reply text. */
  text: string;
  /**
   * Token cost for this invocation.
   * Optional — implementations that cannot measure cost leave it absent.
   */
  tokenCost?: number;
  /**
   * The AgentId of the subagent that produced this response, if known.
   * Format: `{kind}:{scope}:{id}` per mt#953.
   */
  responderId?: AgentId;
}

/**
 * DI interface for subagent dispatch.
 *
 * Concrete implementations:
 *   - `StubSubagentDispatcher` (below) — returns an error; used in
 *     environments where native dispatch is unavailable (mt#441 pending).
 *   - Test mock — injected by unit tests via constructor argument.
 *   - Future: Task-tool-backed dispatcher once mt#441 lands.
 *
 * The interface is intentionally narrow: one method, no side effects
 * beyond invoking the subagent. Token cost is returned so callers can
 * record it in AttentionCost.
 */
export interface SubagentDispatcher {
  dispatch(request: SubagentRequest): Promise<SubagentResponse>;
}

// ---------------------------------------------------------------------------
// Stub dispatcher (pending mt#441)
// ---------------------------------------------------------------------------

/**
 * Stub SubagentDispatcher that rejects with an explicit "not yet available"
 * error until the native Task-tool integration (mt#441) ships.
 *
 * Use as the default in production DI trees so the transport correctly
 * reports that it cannot dispatch rather than silently succeeding.
 *
 * TODO(mt#441): Replace this stub with the Task-tool-backed implementation
 * once native subagent dispatch ships. The Task tool in Claude Code can
 * invoke a subagent with a model parameter; that call should land here.
 */
export class StubSubagentDispatcher implements SubagentDispatcher {
  async dispatch(_request: SubagentRequest): Promise<SubagentResponse> {
    throw new Error(
      "SubagentDispatcher not yet available: native Task-tool dispatch requires mt#441 to land. " +
        "Inject a concrete SubagentDispatcher implementation to use this transport."
    );
  }
}

// ---------------------------------------------------------------------------
// ClosedAsk (subagent variant)
// ---------------------------------------------------------------------------

/**
 * A ClosedAsk produced by the subagent transport.
 *
 * Analogous to the `ClosedAsk` in `policy-resolver.ts` but with
 * `routingTarget = "subagent"` and token-cost accounting.
 */
export type SubagentClosedAsk = RoutedAsk & {
  state: "closed";
  routingTarget: "subagent";
};

// ---------------------------------------------------------------------------
// dispatchToSubagent
// ---------------------------------------------------------------------------

/**
 * Default per-step timeout (milliseconds).
 *
 * Applied to each individual subagent invocation. Override by passing
 * `timeoutMs` in `SubagentTransportOptions`.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 60_000;

/**
 * Options for `dispatchToSubagent`.
 */
export interface SubagentTransportOptions {
  /**
   * Injected dispatcher. Defaults to `StubSubagentDispatcher`.
   *
   * Pass a real dispatcher (or a test mock) to override.
   */
  dispatcher?: SubagentDispatcher;

  /**
   * Per-step timeout in milliseconds.
   * @default DEFAULT_SUBAGENT_TIMEOUT_MS (60 000 ms)
   */
  timeoutMs?: number;
}

/**
 * Dispatch a RoutedAsk to a subagent and return a SubagentClosedAsk.
 *
 * Only handles `capability.escalate` and `stuck.unblock` kinds.
 * Throws for any other kind so callers discover mis-routing early.
 *
 * `capability.escalate`:
 *   Dispatches to the model/type extracted from the Ask payload (or defaults
 *   to opus/general-purpose). Returns on first successful response.
 *
 * `stuck.unblock`:
 *   Step 1 of the escalation chain: dispatch to Opus.
 *   Steps 2-4 (mesh peer → Inbox → operator) are stubbed pending
 *   mt#1001 and mt#454. If Opus dispatch succeeds, returns the response.
 *   If Opus fails or times out, returns a closed Ask with an error payload
 *   that records the chain-step-1 failure and references the blocking tasks.
 *
 * Timeout is enforced via `Promise.race` + `AbortController`-style
 * rejection. The timeout is per-invocation, not per-chain.
 *
 * Attention cost: populates `response.attentionCost` using the accounting
 * module's buildAttentionCost with the subagent's responderId (or "subagent"
 * fallback) and token cost. operatorCost is intentionally absent — the
 * operator was never reached in v1.
 */
export async function dispatchToSubagent(
  routedAsk: RoutedAsk,
  options: SubagentTransportOptions = {}
): Promise<SubagentClosedAsk> {
  const { kind } = routedAsk;

  if (kind !== "capability.escalate" && kind !== "stuck.unblock") {
    throw new Error(
      `subagent transport: unsupported kind "${kind}". ` +
        `Only "capability.escalate" and "stuck.unblock" are handled here.`
    );
  }

  const dispatcher = options.dispatcher ?? new StubSubagentDispatcher();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

  if (kind === "capability.escalate") {
    return dispatchEscalate(routedAsk, dispatcher, timeoutMs);
  }

  // kind === "stuck.unblock"
  return dispatchUnblock(routedAsk, dispatcher, timeoutMs);
}

// ---------------------------------------------------------------------------
// capability.escalate handler
// ---------------------------------------------------------------------------

/**
 * Extract subagent request parameters from a `capability.escalate` Ask.
 *
 * The Ask's `metadata` may carry `model` and `agentType` set by the caller
 * at ask-creation time. Falls back to safe defaults.
 */
function extractEscalateRequest(routedAsk: RoutedAsk): SubagentRequest {
  const meta = routedAsk.metadata ?? {};
  const model = typeof meta["model"] === "string" ? (meta["model"] as SubagentModel) : "opus";
  const type =
    typeof meta["agentType"] === "string"
      ? (meta["agentType"] as SubagentRequest["type"])
      : "general-purpose";

  return {
    model,
    type,
    prompt: buildPrompt(routedAsk),
  };
}

async function dispatchEscalate(
  routedAsk: RoutedAsk,
  dispatcher: SubagentDispatcher,
  timeoutMs: number
): Promise<SubagentClosedAsk> {
  const request = extractEscalateRequest(routedAsk);

  let subagentResponse: SubagentResponse;
  try {
    subagentResponse = await withTimeout(dispatcher.dispatch(request), timeoutMs);
  } catch (err) {
    return buildErrorClose(routedAsk, "capability.escalate", err);
  }

  return buildSuccessClose(routedAsk, subagentResponse, "general-purpose");
}

// ---------------------------------------------------------------------------
// stuck.unblock handler (chain step 1 — Opus only)
// ---------------------------------------------------------------------------

async function dispatchUnblock(
  routedAsk: RoutedAsk,
  dispatcher: SubagentDispatcher,
  timeoutMs: number
): Promise<SubagentClosedAsk> {
  // Chain step 1: Opus dispatch.
  const request: SubagentRequest = {
    model: "opus",
    type: "general-purpose",
    prompt: buildPrompt(routedAsk),
  };

  let subagentResponse: SubagentResponse;
  try {
    subagentResponse = await withTimeout(dispatcher.dispatch(request), timeoutMs);
  } catch (err) {
    // Chain step 1 failed. Steps 2-4 are blocked on mt#1001/mt#454.
    // Return a closed Ask with an explicit error payload rather than
    // pretending the chain succeeded.
    // TODO(mt#1001, mt#454): extend chain walker:
    //   step 2: mesh peer dispatch → if fails/timeout → step 3
    //   step 3: Inbox (mt#454) → if timeout exceeded → step 4
    //   step 4: operator escalation
    return buildErrorClose(routedAsk, "stuck.unblock chain step 1 (Opus)", err);
  }

  // Step 1 succeeded. Chain steps 2-4 are out of scope for v1.
  // TODO(mt#1001, mt#454): if the Opus response indicates it could not
  // unblock the issue, proceed to chain step 2 (mesh peer dispatch).
  return buildSuccessClose(routedAsk, subagentResponse, "stuck.unblock-step1");
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a `timeoutMs` rejection.
 *
 * Uses `AbortController`-style cleanup: the timeout `setTimeout` handle
 * is cleared when the promise resolves or rejects to avoid memory leaks.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;

    const handle = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`Subagent dispatch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(handle);
          resolve(value);
        }
      },
      (err) => {
        if (!done) {
          done = true;
          clearTimeout(handle);
          reject(err);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Response-packaging helpers
// ---------------------------------------------------------------------------

/**
 * Build the prompt to send to the subagent from the RoutedAsk's question
 * and context refs.
 */
function buildPrompt(routedAsk: RoutedAsk): string {
  const parts: string[] = [routedAsk.question];

  if (routedAsk.contextRefs && routedAsk.contextRefs.length > 0) {
    parts.push("\n## Context");
    for (const ref of routedAsk.contextRefs) {
      const desc = ref.description ? ` — ${ref.description}` : "";
      parts.push(`- ${ref.kind}: ${ref.ref}${desc}`);
    }
  }

  return parts.join("\n");
}

/**
 * Package a successful subagent response into a SubagentClosedAsk.
 *
 * Uses the accounting module's buildAttentionCost with the subagent's
 * responderId (or "subagent" fallback) so there is one source of truth
 * for the transport/resolvedIn mapping. operatorCost is intentionally
 * absent — the operator was never reached on this transport at v1.
 */
function buildSuccessClose(
  routedAsk: RoutedAsk,
  subagentResponse: SubagentResponse,
  _step: string
): SubagentClosedAsk {
  const now = new Date().toISOString();

  const transport: TransportBinding = { kind: "subagent" };

  const packagedPayload: AskPayload = {
    question: routedAsk.question,
    options: routedAsk.options,
    contextRefs: routedAsk.contextRefs,
  };

  // Use responderId if available (may be "agui:foo", "mesh:foo", etc.);
  // fall back to "subagent" for anonymous dispatches.
  const responder: AgentId | "operator" | "policy" | "timeout" =
    subagentResponse.responderId ?? "subagent";

  // Delegate to the accounting module — one source of truth for transport mapping.
  // operatorCost is omitted: per ADR-008, it is only present when escalated to a human.
  const attentionCost = buildAttentionCost({
    responder,
    tokenCost: subagentResponse.tokenCost,
  });

  return {
    ...routedAsk,
    state: "closed",
    routingTarget: "subagent",
    transport,
    packagedPayload,
    routedAt: routedAsk.routedAt ?? now,
    closedAt: now,
    response: {
      responder,
      payload: {
        text: subagentResponse.text,
      },
      attentionCost,
    },
  };
}

/**
 * Package a dispatch failure into a SubagentClosedAsk.
 *
 * The Ask is still "closed" — it is terminal. The error is in the
 * response payload so the caller can inspect it and decide whether to
 * escalate further (e.g., retry with a different transport).
 *
 * For error closes, the responder is "timeout" (the invocation timed out
 * or failed), and attentionCost reflects that via the accounting module.
 */
function buildErrorClose(routedAsk: RoutedAsk, stepName: string, err: unknown): SubagentClosedAsk {
  const now = new Date().toISOString();

  const errorMessage = err instanceof Error ? err.message : String(err);

  const transport: TransportBinding = { kind: "subagent" };

  const packagedPayload: AskPayload = {
    question: routedAsk.question,
    options: routedAsk.options,
    contextRefs: routedAsk.contextRefs,
  };

  // Error close: responder is "timeout" (chain failed without a human reaching it).
  // The accounting module maps "timeout" → { transport: "timeout", resolvedIn: "timeout" }.
  const attentionCost = buildAttentionCost({ responder: "timeout" });

  return {
    ...routedAsk,
    state: "closed",
    routingTarget: "subagent",
    transport,
    packagedPayload,
    routedAt: routedAsk.routedAt ?? now,
    closedAt: now,
    response: {
      responder: "timeout",
      payload: {
        error: `${stepName} failed; chain extension blocked on mt#1001/mt#454`,
        errorDetail: errorMessage,
      },
      attentionCost,
    },
  };
}
