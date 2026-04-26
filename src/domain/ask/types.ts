/**
 * Ask entity TypeScript types — ADR-008 §The Ask entity.
 *
 * The Ask subsystem provides a unified domain type for all human-in-the-loop
 * mechanisms in Minsky: inbox rows, AG-UI interrupts, PR approvals, mesh
 * notifications, and 2-strikes escalations are all instances of Ask.
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md
 */

/**
 * Formatted agent identity string: `{kind}:{scope}:{id}[@{parent-agentId}]`
 * as defined in ADR-006 (mt#953).
 *
 * Examples:
 *   com.anthropic.claude-code:proc:a1b2c3d4e5f6g7h8
 *   minsky.native-subagent:task:mt#123@com.anthropic.claude-code:proc:a1b2c3d4
 */
export type AgentId = string;

/**
 * Seven-kind taxonomy for Ask routing.
 *
 * Naming convention: `{domain}.{verb}`
 * Each kind is a distinct routing/SLA/posture cluster — not a UX category.
 *
 * | Kind                    | What it asks                                                   | Sync/Async              | Default target                     |
 * |-------------------------|----------------------------------------------------------------|-------------------------|------------------------------------|
 * | capability.escalate     | Thinker not smart enough — bigger model, specialist subagent   | Sync, seconds           | Subagent (Opus / specialist)       |
 * | information.retrieve    | Missing a fact — docs, search, a prior artifact                | Mostly sync, sec–min    | Retriever; operator iff uncaptured |
 * | authorization.approve   | Can act, shouldn't without permission — policy first           | Sync, sec–hours         | Policy → operator                  |
 * | direction.decide        | Preference-bound choice — architectural, scope-level           | Async, hours–days       | Operator (rarely automatable)      |
 * | coordination.notify     | Peer might be affected — informational, not blocking           | Fire-and-forget         | Peer agents, mesh broadcast        |
 * | quality.review          | Output needs validation — tests, reviewers, taste              | Async-OK, min–hours     | Reviewer agent → operator          |
 * | stuck.unblock           | Multiple attempts failed, fresh eyes needed                    | Sync if critical-path   | Opus → peer → operator             |
 */
export type AskKind =
  | "capability.escalate"
  | "information.retrieve"
  | "authorization.approve"
  | "direction.decide"
  | "coordination.notify"
  | "quality.review"
  | "stuck.unblock";

/**
 * Eight-stage lifecycle state machine for an Ask.
 *
 * Lifecycle stages (in order):
 *   Detection → Classification → Routing → Packaging →
 *   Suspension → Response → Resumption → Accounting
 *
 * Terminal states: closed, cancelled, expired.
 */
export type AskState =
  /** Classifier produced it; router hasn't run yet. */
  | "detected"
  /** Kind assigned; router picking a target. */
  | "classified"
  /** Target selected; transport dispatch pending. */
  | "routed"
  /** Waiting for response (sync or async). */
  | "suspended"
  /** Response received, not yet closed (validation/side effects). */
  | "responded"
  /** Terminal: successfully resolved. */
  | "closed"
  /** Terminal: operator or upstream cancelled before response. */
  | "cancelled"
  /** Terminal: deadline passed with no response. */
  | "expired";

/**
 * A single option within a decision-framed Ask.
 *
 * Used when the Ask carries a structured decision frame (e.g., for
 * `direction.decide` and `authorization.approve` asks). The `label`
 * is the human-readable name; `value` is what the router stores in
 * the response payload; `description` provides additional context.
 */
export interface AskOption {
  /** Short human-readable label for this option. */
  label: string;
  /** Machine-readable value stored in the response payload. */
  value: unknown;
  /** Optional longer description of this option's tradeoffs. */
  description?: string;
}

/**
 * A pointer to a contextual artifact the responder may need.
 *
 * Examples: a diff, a file, a spec, a prior Ask, a task spec.
 * The `kind` field is open-ended — use well-known values like
 * "diff", "file", "spec", "ask", "task-spec" where applicable.
 */
export interface ContextRef {
  /** Type of the referenced artifact. */
  kind: string;
  /** URI or path identifying the artifact. */
  ref: string;
  /** Optional human-readable description. */
  description?: string;
}

/**
 * Attention cost recorded when an Ask is closed.
 *
 * v1 accounting is intentionally coarse: ordinal operator-cost buckets
 * rather than precise wall-clock measurement. The metric that matters
 * at v1 is frequency-per-kind-per-task, which surfaces high-cost patterns
 * without false precision.
 */
export interface AttentionCost {
  /**
   * Agent/subagent token cost (measured).
   * Only present for asks routed to subagents or retrievers.
   */
  tokenCost?: number;

  /**
   * Operator attention cost (estimated).
   * Present when the ask was escalated to a human.
   *
   * `kind` is an ordinal bucket:
   *   - "quick" — glance / one-click approval
   *   - "medium" — read + decide (minutes)
   *   - "deep"  — read + research + decide (hours)
   */
  operatorCost?: {
    kind: "quick" | "medium" | "deep";
    /** Wall-clock seconds, measured when available. */
    wallClockSec?: number;
  };

  /** Which transport carried this Ask to its resolver. */
  transport: TransportKind;

  /** How the Ask was ultimately resolved. */
  resolvedIn: "policy" | "subagent" | "inbox" | "mesh" | "agui" | "timeout";
}

/**
 * Transport kinds that can carry an Ask to its resolver.
 *
 * Derived from the transport-binding matrix in ADR-008.
 */
export type TransportKind = "policy" | "subagent" | "inbox" | "mesh" | "agui" | "timeout";

/**
 * The Ask entity — the unified domain type for all HITL mechanisms.
 *
 * An Ask is generic across transports: one routed via AG-UI and one routed
 * to the inbox share the same schema. The difference is a function of
 * `kind` × `routingTarget` × the transport adapter.
 *
 * Identity fields use the `{kind}:{scope}:{id}` AgentId format from mt#953.
 * All timestamps are ISO-8601 strings.
 */
export interface Ask {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** ULID or UUID uniquely identifying this Ask. */
  id: string;

  /** Seven-kind taxonomy label. */
  kind: AskKind;

  /**
   * Version tag of the classifier that assigned `kind`.
   *
   * Carried on each Ask so the taxonomy can evolve without orphaning
   * historical rows. Reclassification runs as a background migration,
   * never on the hot path.
   */
  classifierVersion: string;

  // -------------------------------------------------------------------------
  // Participants (agent identity from mt#953)
  // -------------------------------------------------------------------------

  /**
   * Who is asking, in `{kind}:{scope}:{id}` format.
   * Required — every Ask has a requestor.
   */
  requestor: AgentId;

  /**
   * Who the router selected as the resolver.
   *
   * - An `AgentId` string for agent-to-agent asks.
   * - `"operator"` for human escalation.
   * - `"policy"` when existing policy covers the action (short-circuit close).
   *
   * Absent until the router has run (state = "classified" or earlier).
   */
  routingTarget?: AgentId | "operator" | "policy";

  // -------------------------------------------------------------------------
  // Context & payload
  // -------------------------------------------------------------------------

  /**
   * Parent task ID (e.g., "mt#123").
   * Nullable — some asks are session-scoped without a task parent.
   */
  parentTaskId?: string;

  /**
   * Parent session UUID, when the Ask originated in an active session.
   */
  parentSessionId?: string;

  /** Short summary line used for list rendering and notifications. */
  title: string;

  /** The full ask body — what the requestor needs resolved. */
  question: string;

  /**
   * Structured decision frame.
   *
   * Present for decision-like kinds (`direction.decide`,
   * `authorization.approve`). Absent for informational or notification
   * kinds (`coordination.notify`).
   */
  options?: AskOption[];

  /**
   * Pointers to contextual artifacts the responder may need.
   *
   * Examples: relevant diffs, files, specs, prior asks.
   */
  contextRefs?: ContextRef[];

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Current lifecycle state. */
  state: AskState;

  /**
   * Soft deadline in ISO-8601 format.
   * When exceeded with no response, the Ask transitions to "expired".
   */
  deadline?: string;

  /** ISO-8601 timestamp when the Ask was first detected. */
  createdAt: string;

  /** ISO-8601 timestamp when a routing target was selected. */
  routedAt?: string;

  /** ISO-8601 timestamp when the Ask entered "suspended" state. */
  suspendedAt?: string;

  /** ISO-8601 timestamp when a response was received. */
  respondedAt?: string;

  /** ISO-8601 timestamp when the Ask reached a terminal state. */
  closedAt?: string;

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  /**
   * The resolved response, present once state = "responded" or "closed".
   *
   * `payload` is kind-specific; typed via discriminated union in per-kind
   * modules (not in this file — this file is types-only).
   * `attentionCost` is filled on close.
   */
  response?: {
    /** Who resolved the Ask. */
    responder: AgentId | "operator" | "policy" | "timeout";
    /** Kind-specific response payload. */
    payload: unknown;
    /** Attention cost, computed and written when the Ask closes. */
    attentionCost?: AttentionCost;
  };

  // -------------------------------------------------------------------------
  // Extensibility
  // -------------------------------------------------------------------------

  /**
   * Arbitrary metadata for transport adapters, future extensions, and
   * tooling that doesn't yet have a first-class field.
   */
  metadata: Record<string, unknown>;
}

/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Use in the default branch of a switch over `AskKind` or `AskState` to force
 * TypeScript to error if a new variant is added without being handled. This is
 * the mechanical guard the per-kind modules (payload / response / router) rely
 * on — if the taxonomy grows, every consumer that exhaustively switches will
 * break until updated.
 *
 * @example
 *   function handle(kind: AskKind): string {
 *     switch (kind) {
 *       case "quality.review": return "review";
 *       case "direction.decide": return "decide";
 *       // ...all other kinds...
 *       default: return assertNever(kind);
 *     }
 *   }
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
