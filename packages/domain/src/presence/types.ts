/**
 * Presence claim domain types (mt#2562).
 *
 * A PresenceClaim is a soft, TTL-refreshed signal that records
 * "actor A is working on subject X right now."
 *
 * Cross-grain: subject_kind discriminates 'task' (v1), 'session' (mt#2284),
 * 'subagent' (mt#2292). The schema is designed so the later two grains adopt
 * this same record shape without a breaking redefinition.
 */

/** Discriminator for the subject of the claim. */
export type PresenceSubjectKind = "task" | "session" | "subagent";

/**
 * A presence claim record (the domain representation, distinct from the DB row).
 *
 * All "where-context" fields are optional — they are populated best-effort
 * from the MCP request extras, and may be absent for headless callers.
 */
export interface PresenceClaim {
  id: string;

  /** Grain discriminator. 'task' for v1. */
  subjectKind: PresenceSubjectKind;

  /**
   * Normalized subject identifier.
   * For task grain: the canonical task id, e.g. "mt#2562".
   */
  subjectId: string;

  /**
   * Actor identity — the io.minsky/agent_id value (mt#1078).
   * Resolved via resolveCallerAgentId in server.ts.
   */
  actorId: string;

  // ---- Where-context (all nullable) -----------------------------------------

  /** Claude Code conversation id (the cc sessionId / conversation UUID). */
  ccConversationId?: string;

  /** TTY device path (e.g. /dev/ttys003). */
  tty?: string;

  /** Hostname — forward-compat for cross-host mesh presence. */
  host?: string;

  /** Minsky session workspace id — set when the claim coincides with a session. */
  sessionId?: string;

  // ---- Project scoping -------------------------------------------------------

  /** Project uuid (FK to projects.id). Stamped on write. */
  projectId?: string;

  // ---- Timestamps ------------------------------------------------------------

  /** When the claim was first created. */
  claimedAt: string; // ISO-8601

  /** When the claim was last refreshed (upsert refreshes this). */
  lastRefreshedAt: string; // ISO-8601
}

/**
 * A presence claim annotated with a staleness flag.
 * Returned by listClaims when staleThresholdMs is provided.
 */
export interface AnnotatedPresenceClaim extends PresenceClaim {
  /** True when last_refreshed_at is older than the staleness threshold. */
  stale: boolean;
}

/** Input for upserting a presence claim. */
export interface UpsertPresenceClaimInput {
  subjectKind: PresenceSubjectKind;
  subjectId: string;
  actorId: string;
  ccConversationId?: string;
  tty?: string;
  host?: string;
  sessionId?: string;
  projectId?: string;
}

/**
 * Default TTL for presence claims — 15 minutes.
 * A working agent touches the task well inside 15m (grounded per
 * decision-defaults §Thresholds).
 */
export const PRESENCE_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Hard reap threshold — 24 hours.
 * Claims older than this are deleted by reapStale().
 */
export const PRESENCE_CLAIM_REAP_MS = 24 * 60 * 60 * 1000; // 24 hours
