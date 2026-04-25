/**
 * Ask Domain Types
 *
 * Core type definitions for the Ask entity — Wave 1 of the attention-allocation
 * subsystem (mt#1034 ADR; renumbering tracked in mt#1291).
 *
 * An Ask represents an agent-to-human (or agent-to-agent) attention request.
 * The 7 kinds cover all classes of asks identified in the ADR:
 *   capability.escalate, direction.decide, quality.review, authorization.approve,
 *   information.retrieve, coordination.notify, stuck.unblock
 *
 * @see mt#1068 Ask entity spec
 * @see mt#1034 attention-allocation ADR (in-flight; ADR number TBD per mt#1291)
 */

// Re-export AgentId type alias from agent-identity module
export type { AgentIdScope } from "../agent-identity/format";

/**
 * AgentId — opaque string in the format `{kind}:{scope}:{id}[@{parent}]`.
 *
 * Defined as `string` here rather than imported from `../agent-identity` so the
 * Ask subsystem can land before agent-identity's stable branded type ships
 * (mt#953 / mt#992). When mt#953 produces a branded `AgentId`, this type
 * becomes a re-export and call sites continue to compile.
 */
export type AgentId = string;

// ---------------------------------------------------------------------------
// AskKind — 7-variant discriminant
// ---------------------------------------------------------------------------

/**
 * All valid Ask kind values.
 * Used as the `kind` discriminant on payload/response union types.
 */
export const ASK_KINDS = {
  CAPABILITY_ESCALATE: "capability.escalate",
  DIRECTION_DECIDE: "direction.decide",
  QUALITY_REVIEW: "quality.review",
  AUTHORIZATION_APPROVE: "authorization.approve",
  INFORMATION_RETRIEVE: "information.retrieve",
  COORDINATION_NOTIFY: "coordination.notify",
  STUCK_UNBLOCK: "stuck.unblock",
} as const;

export type AskKind = (typeof ASK_KINDS)[keyof typeof ASK_KINDS];

/**
 * Exhaustiveness helper — call in the `default` branch of a switch over AskKind.
 * TypeScript will error at compile time if any variant is unhandled.
 */
export function assertNeverKind(kind: never): never {
  throw new Error(`Unhandled AskKind: ${String(kind)}`);
}

// ---------------------------------------------------------------------------
// AskState — lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * State transitions:
 *   pending → routed → suspended → responded → closed
 *                              └─────────────────→ closed  (skip suspended)
 *   pending → closed  (cancelled without routing)
 */
export const ASK_STATES = {
  PENDING: "pending",
  ROUTED: "routed",
  SUSPENDED: "suspended",
  RESPONDED: "responded",
  CLOSED: "closed",
} as const;

export type AskState = (typeof ASK_STATES)[keyof typeof ASK_STATES];

/**
 * Valid state transitions (from → to).
 * The router enforces these; the repository does not.
 */
export const VALID_ASK_TRANSITIONS: Record<AskState, AskState[]> = {
  pending: ["routed", "closed"],
  routed: ["suspended", "responded", "closed"],
  suspended: ["responded", "closed"],
  responded: ["closed"],
  closed: [],
};

// ---------------------------------------------------------------------------
// TransportKind and TransportBinding
// ---------------------------------------------------------------------------

/**
 * Transport kinds — identifies how/where an Ask is delivered.
 *
 * `policy`, `subagent`, `inbox`, `mesh`, `agui` are real transports the
 * router (mt#1069) selects between. `timeout` only appears as a *responder*
 * label (`AskResponse.responder`) when the Ask expires past `deadline`
 * without a response — a deadline-driven Ask is never *bound* to a
 * "timeout transport" at routing time. The `TransportKind` literal is shared
 * for symmetry with `AskResponse.responder`-derived accounting; callers
 * constructing a `TransportBinding` should never pass `kind: "timeout"`.
 */
export type TransportKind = "policy" | "subagent" | "inbox" | "mesh" | "agui" | "timeout";

/**
 * TransportBinding — attached to a routed Ask by the router (mt#1069).
 * Stored in the `routing_target` column as JSONB.
 *
 * Invariant: `kind` should not be "timeout" — see `TransportKind` doc.
 */
export interface TransportBinding {
  kind: TransportKind;
  target: AgentId | "operator" | "policy";
}

// ---------------------------------------------------------------------------
// Per-kind payload discriminated union (v1 minimal shapes)
// ---------------------------------------------------------------------------

export interface CapabilityEscalatePayload {
  kind: "capability.escalate";
  model: string;
  prompt: string;
  specialistType?: string;
}

export interface DirectionDecidePayload {
  kind: "direction.decide";
  alternatives: Array<{ id: string; label: string; tradeoffs?: string }>;
  recommendation?: string;
}

export interface QualityReviewPayload {
  kind: "quality.review";
  artifact: string;
  criteria?: string[];
}

export interface AuthorizationApprovePayload {
  kind: "authorization.approve";
  action: string;
  diff?: string;
  rationale?: string;
}

export interface InformationRetrievePayload {
  kind: "information.retrieve";
  query: string;
}

export interface CoordinationNotifyPayload {
  kind: "coordination.notify";
  event: string;
  detail?: unknown;
}

export interface StuckUnblockPayload {
  kind: "stuck.unblock";
  attempts: string[];
  lastError?: string;
}

/**
 * AskPayload — discriminated union keyed by `kind`.
 * The `kind` field on the payload matches the `kind` field on the Ask entity.
 */
export type AskPayload =
  | CapabilityEscalatePayload
  | DirectionDecidePayload
  | QualityReviewPayload
  | AuthorizationApprovePayload
  | InformationRetrievePayload
  | CoordinationNotifyPayload
  | StuckUnblockPayload;

// ---------------------------------------------------------------------------
// Per-kind response discriminated union
// ---------------------------------------------------------------------------

export interface CapabilityEscalateResponse {
  kind: "capability.escalate";
  output: string;
}

export interface DirectionDecideResponse {
  kind: "direction.decide";
  chosenId: string;
  rationale?: string;
}

export interface QualityReviewResponse {
  kind: "quality.review";
  verdict: "approve" | "reject" | "changes";
  comments?: string;
}

export interface AuthorizationApproveResponse {
  kind: "authorization.approve";
  decision: "approve" | "deny";
  reason?: string;
}

export interface InformationRetrieveResponse {
  kind: "information.retrieve";
  answer: string;
  citations?: string[];
}

export interface CoordinationNotifyResponse {
  kind: "coordination.notify";
  acknowledged: boolean;
}

export interface StuckUnblockResponse {
  kind: "stuck.unblock";
  suggestion: string;
  nextStep?: string;
}

/**
 * AskResponsePayload — per-kind discriminated union keyed by `kind`.
 *
 * Note on coordination.notify: the kind is fire-and-forget at the *Ask* level
 * — `Ask.response` may stay `null` permanently for a `coordination.notify`
 * Ask. When a response *is* recorded (e.g., the receiver explicitly ACKs),
 * the payload still has all fields required by `CoordinationNotifyResponse`.
 * Optionality lives at the Ask level (`response: AskResponse | null`), not
 * inside the payload variant.
 *
 * This is the body of the response — the actual answer to the Ask. It's
 * wrapped by `AskResponse` (below) which adds `responder` and `attentionCost`
 * per the attention-allocation ADR (mt#1034) §The Ask entity.
 */
export type AskResponsePayload =
  | CapabilityEscalateResponse
  | DirectionDecideResponse
  | QualityReviewResponse
  | AuthorizationApproveResponse
  | InformationRetrieveResponse
  | CoordinationNotifyResponse
  | StuckUnblockResponse;

/**
 * AskResponse — full response envelope per ADR-006 §The Ask entity.
 *
 * Carries:
 *   - `responder`: who answered (agent, operator, policy, or timeout)
 *   - `payload`: the kind-discriminated answer body (`AskResponsePayload`)
 *   - `attentionCost`: optional, filled by the accounting rollup (mt#1071)
 *
 * Stored as JSONB on the `asks` table's `response` column.
 */
export interface AskResponse {
  /** Who produced the response — first-class pseudo-agents are "operator", "policy", "timeout" */
  responder: AgentId | "operator" | "policy" | "timeout";
  /** Per-kind payload (discriminated by `kind`) */
  payload: AskResponsePayload;
  /** Optional attention cost — written by the accounting layer (mt#1071) */
  attentionCost?: AttentionCost;
}

// ---------------------------------------------------------------------------
// AttentionCost (accounting summary — stored on close)
// ---------------------------------------------------------------------------

/**
 * AttentionCost — records where attention was spent after an Ask closes.
 *
 * Canonical storage: `Ask.response.attentionCost` (i.e., on the response
 * envelope, not in `metadata`). The accounting rollup (mt#1071) writes
 * here on close. `metadata` is reserved for caller-supplied bookkeeping
 * and must not duplicate this datum.
 */
export interface AttentionCost {
  /** Transport that ultimately resolved the ask */
  resolvedIn: TransportKind;
  /** Elapsed wall-clock time in milliseconds from creation to close */
  elapsedMs: number;
  /** Number of routing hops before resolution */
  hops: number;
}

// ---------------------------------------------------------------------------
// Core Ask entity
// ---------------------------------------------------------------------------

/**
 * Ask — core attention-request entity (ADR-006 §The Ask entity).
 *
 * Lifecycle timestamps:
 *   createdAt    — when the Ask was inserted
 *   routedAt     — when the router assigned a TransportBinding
 *   suspendedAt  — when the Ask entered SUSPENDED state (awaiting async response)
 *   respondedAt  — when a response was recorded
 *   closedAt     — when the Ask transitioned to CLOSED
 */
export interface Ask {
  id: string;
  kind: AskKind;
  /** Classifier version string (e.g. "v1") for future schema evolution */
  classifierVersion: string;
  state: AskState;
  /** AgentId of the agent that raised this Ask */
  requestor: AgentId;
  /** Routing target — set by the router (mt#1069); null until routed */
  routingTarget: TransportBinding | null;
  /** Parent task context (null if not within a task) */
  parentTaskId: string | null;
  /** Parent session context (null if not within a session) */
  parentSessionId: string | null;
  /** Short human-readable title for operator surfaces */
  title: string;
  /** Full question or payload description */
  question: string;
  /** Discriminated payload (serialized as JSONB in DB) */
  payload: AskPayload;
  /** Discriminated response — null until the Ask is responded/closed */
  response: AskResponse | null;
  /** Arbitrary additional metadata (e.g., AttentionCost on close) */
  metadata: Record<string, unknown> | null;
  /** Optional deadline — Ask auto-closes via timeout transport if exceeded */
  deadline: Date | null;
  // Lifecycle timestamps
  createdAt: Date;
  routedAt: Date | null;
  suspendedAt: Date | null;
  respondedAt: Date | null;
  closedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Fields required to create a new Ask.
 * The repository's createAsk() helper defaults lifecycle timestamps.
 */
export interface AskCreateInput {
  kind: AskKind;
  classifierVersion?: string;
  requestor: AgentId;
  parentTaskId?: string | null;
  parentSessionId?: string | null;
  title: string;
  question: string;
  payload: AskPayload;
  metadata?: Record<string, unknown> | null;
  deadline?: Date | null;
}

/**
 * Filter options for list queries.
 */
export interface AskListFilter {
  state?: AskState;
  parentTaskId?: string;
  parentSessionId?: string;
  classifierVersion?: string;
  kind?: AskKind;
}

/**
 * Input for closing an Ask with a response.
 */
export interface AskCloseInput {
  response: AskResponse;
  metadata?: Record<string, unknown> | null;
}
