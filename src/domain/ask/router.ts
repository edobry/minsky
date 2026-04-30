/**
 * Ask router — ADR-008 §Router.
 *
 * Two-phase decision:
 *   Phase 1: policy consultation — if an existing policy covers the Ask,
 *            short-circuit to closed with responder="policy".
 *   Phase 2: for uncovered asks, pick routingTarget and transport by kind
 *            per the ADR-008 transport-binding matrix.
 *
 * This module does NOT dispatch to non-policy transports. Inbox, AG-UI,
 * mesh, and subagent dispatch are separate child tasks (mt#1070, mt#454,
 * mt#700, mt#1001). The router produces a RoutedAsk; transport adapters
 * consume it.
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 */

import { log } from "../../utils/logger";
import type { Ask, AgentId, TransportKind, AskKind } from "./types";
import { assertNever } from "./types";
import { loadAllPolicySources, isCovered } from "./policy";
import type { PolicyCitation } from "./policy";
import { closeWithPolicy } from "./transports/policy-resolver";

// ---------------------------------------------------------------------------
// Transport binding
// ---------------------------------------------------------------------------

/**
 * A transport binding produced by the router for a single Ask.
 *
 * The `kind` field identifies which transport adapter should carry this Ask.
 * `target` is an optional secondary discriminator (e.g., the specific peer
 * for mesh notifications; not used in v1).
 */
export interface TransportBinding {
  /** Which transport carries this Ask. */
  kind: TransportKind;
  /** Optional secondary target identifier (future use). */
  target?: string;
}

// ---------------------------------------------------------------------------
// AskPayload
// ---------------------------------------------------------------------------

/**
 * The packaged payload for a routed Ask.
 *
 * v1: thin wrapper around the Ask's own question/options/contextRefs.
 * Future: kind-specific discriminated unions with deadline, fallback, etc.
 */
export interface AskPayload {
  /** Forwarded from the original Ask. */
  question: string;
  /** Forwarded from the original Ask (present for decision-like kinds). */
  options?: Ask["options"];
  /** Forwarded from the original Ask. */
  contextRefs?: Ask["contextRefs"];
  /**
   * Policy citation — only present when transport.kind = "policy".
   * The citation identifies which policy statement covered this Ask.
   */
  citation?: PolicyCitation;
}

// ---------------------------------------------------------------------------
// RoutedAsk
// ---------------------------------------------------------------------------

/**
 * An Ask after the router has run.
 *
 * `state` is either "routed" (dispatching to a transport) or "closed"
 * (policy covered it; no further dispatch needed).
 *
 * `routingTarget` is required on RoutedAsk — the router must always
 * produce a definitive target.
 */
export interface RoutedAsk extends Ask {
  state: "routed" | "closed";
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
  packagedPayload: AskPayload;
}

// ---------------------------------------------------------------------------
// Router interface
// ---------------------------------------------------------------------------

export interface AskRouter {
  route(ask: Ask): Promise<RoutedAsk>;
}

// ---------------------------------------------------------------------------
// Transport-binding matrix (ADR-008 §Transport-binding matrix)
// ---------------------------------------------------------------------------

/**
 * Pick the primary transport for an uncovered Ask by kind.
 *
 * This encodes the v1 defaults from the ADR-008 transport-binding matrix.
 * Callers that need to override the transport can set `ask.routingTarget`
 * before calling the router (future extension).
 *
 * Kinds and their v1 defaults:
 *   capability.escalate  → subagent
 *   information.retrieve → retriever (v1: no operator fallback inline)
 *   authorization.approve → inbox (async default; AG-UI is secondary)
 *   direction.decide     → inbox
 *   coordination.notify  → mesh
 *   quality.review       → inbox
 *   stuck.unblock        → subagent
 */
function pickTransport(kind: AskKind): {
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
} {
  switch (kind) {
    case "capability.escalate":
      return {
        routingTarget: "subagent",
        transport: { kind: "subagent" },
      };

    case "information.retrieve":
      // v1: route to retriever transport. Operator escalation if uncaptured
      // is a future extension (no inbox fallback inline at v1).
      return {
        routingTarget: "retriever",
        transport: { kind: "subagent" }, // retriever treated as subagent at v1
      };

    case "authorization.approve":
      // Policy-resolver is Phase 1 (handled before we reach pickTransport).
      // Uncovered: async inbox as v1 default; AG-UI interrupt is secondary.
      return {
        routingTarget: "operator",
        transport: { kind: "inbox" },
      };

    case "direction.decide":
      return {
        routingTarget: "operator",
        transport: { kind: "inbox" },
      };

    case "coordination.notify":
      return {
        routingTarget: "peer",
        transport: { kind: "mesh" },
      };

    case "quality.review":
      // Reviewer subagent first; operator inbox for taste pass.
      // v1 default: inbox (covers both paths).
      return {
        routingTarget: "reviewer",
        transport: { kind: "inbox" },
      };

    case "stuck.unblock":
      return {
        routingTarget: "subagent",
        transport: { kind: "subagent" },
      };

    default:
      return assertNever(kind);
  }
}

// ---------------------------------------------------------------------------
// packagePayload helper
// ---------------------------------------------------------------------------

/**
 * Build the packaged payload for a non-policy routed Ask.
 *
 * v1: forward question, options, and contextRefs from the original Ask.
 * Future: kind-specific payload builders with deadline, fallback, etc.
 */
function packagePayload(ask: Ask): AskPayload {
  return {
    question: ask.question,
    options: ask.options,
    contextRefs: ask.contextRefs,
  };
}

// ---------------------------------------------------------------------------
// policyFirstRoute — concrete router implementation
// ---------------------------------------------------------------------------

/**
 * Options for `policyFirstRoute`.
 */
export interface PolicyFirstRouteOptions {
  /**
   * Workspace root for loading policy sources (CLAUDE.md, project rules).
   * Defaults to `process.cwd()` when not provided.
   */
  workspaceRoot?: string;

  /**
   * Task spec text for policy coverage.
   * Pass `null` to skip task-spec consultation.
   */
  specContent?: string | null;
}

/**
 * A router that consults policy first, then routes by kind.
 *
 * Phase 1: Load all policy sources and check coverage via `isCovered`.
 *   - If covered: return a closed RoutedAsk with responder="policy" and citation.
 *   - Log if the Ask's self-declared kind disagrees with the policy response
 *     (classifier-vs-policy disagreement audit).
 *
 * Phase 2: For uncovered asks, pick routingTarget and transport via the
 *   transport-binding matrix and return a routed RoutedAsk.
 */
export async function policyFirstRoute(
  ask: Ask,
  options: PolicyFirstRouteOptions = {}
): Promise<RoutedAsk> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const specContent = options.specContent ?? null;

  // -----------------------------------------------------------------------
  // Phase 1: policy consultation
  // -----------------------------------------------------------------------

  const sources = await loadAllPolicySources(workspaceRoot, specContent);
  const coverage = isCovered(ask, sources);

  if (coverage.covered && coverage.citation) {
    // Policy covers this Ask — short-circuit to closed.
    const closed = closeWithPolicy(ask, coverage.citation);

    // Classifier-vs-policy audit: if the Ask wasn't already targeted at
    // "policy", log the disagreement. This is observational at v1 — no
    // enforcement, just audit trail.
    if (ask.routingTarget !== "policy") {
      log.debug("ask.router: classifier-policy disagreement", {
        askId: ask.id,
        kind: ask.kind,
        classifierTarget: ask.routingTarget ?? "(unset)",
        resolvedBy: "policy",
        citationSource: coverage.citation.source,
      });
    }

    return closed;
  }

  // -----------------------------------------------------------------------
  // Phase 2: route by kind
  // -----------------------------------------------------------------------

  const { routingTarget, transport } = pickTransport(ask.kind);
  const packagedPayload = packagePayload(ask);

  const now = new Date().toISOString();

  const routed: RoutedAsk = {
    ...ask,
    state: "routed",
    routingTarget,
    transport,
    packagedPayload,
    routedAt: now,
  };

  return routed;
}

// ---------------------------------------------------------------------------
// Factory: build a router from options
// ---------------------------------------------------------------------------

/**
 * Create an `AskRouter` backed by `policyFirstRoute`.
 *
 * Use this factory when you need the router behind the `AskRouter` interface
 * (e.g., for dependency injection). For direct usage, call `policyFirstRoute`
 * directly.
 */
export function createPolicyFirstRouter(options: PolicyFirstRouteOptions = {}): AskRouter {
  return {
    route: (ask: Ask) => policyFirstRoute(ask, options),
  };
}
