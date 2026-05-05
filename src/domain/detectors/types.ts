/**
 * Detector infrastructure types — mt#1035 §Detector interface.
 *
 * Shared type definitions for all System 3* detector surfaces. Each surface
 * (Policy-coverage, Diff-signature, Trajectory-probe, Post-mortem) implements
 * the `Detector` interface and produces `DetectionSignal[]`.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Detector interface
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Detection
 */

import type { AskKind, AskOption, ContextRef } from "../ask/types";

/**
 * Concrete pointer to evidence supporting a detection signal.
 *
 * The `kind` field discriminates the shape of `payload`. Well-known values:
 *   - "file-range"       — a specific file + line range
 *   - "tool-call"        — a recorded tool invocation
 *   - "diff-snippet"     — a fragment of a diff
 *   - "policy-gap"       — a policy lookup that returned no coverage
 *   - "trajectory-step" — a step in the agent's trajectory snapshot
 */
export interface Evidence {
  kind: "file-range" | "tool-call" | "diff-snippet" | "policy-gap" | "trajectory-step";
  payload: unknown;
}

/**
 * An unclassified signal that the agent may have made an unasked direction.
 *
 * Produced by a `Detector` implementation and converted to an `AskIntent`
 * at the router-bridge boundary before being submitted to the Ask router.
 *
 * Per mt#1035 §Detector interface.
 */
export interface DetectionSignal {
  /** Stable identifier for the detector that produced this signal. */
  detectorId: string;

  /** Version of the detector ruleset; used for calibration and dismissal scoping. */
  detectorVersion: string;

  /**
   * The type of Ask this signal suggests.
   *
   * "direction.decide" — a preference-bound direction the operator should approve.
   * "authorization.approve" — an action the agent needs explicit permission to take.
   */
  suspectedKind: Extract<AskKind, "direction.decide" | "authorization.approve">;

  /**
   * Detector's own confidence in this signal.
   *
   * The router may override this when policy-first resolution runs. "high" signals
   * are more likely to escalate; "low" signals may be logged only.
   */
  severity: "low" | "medium" | "high";

  /** Short summary rendered to the operator. */
  summary: string;

  /** Concrete evidence pointers supporting the signal. */
  evidence: Evidence[];

  /** Optional prompt the operator would answer; falls back to `summary` if absent. */
  suggestedQuestion?: string;

  /** Optional structured decision frame for the resulting Ask. */
  suggestedOptions?: AskOption[];

  /** Context references for the resulting Ask (diffs, files, specs). */
  contextRefs: ContextRef[];
}

/**
 * Context for a tool call, used by pre-tool and post-tool surface detectors.
 */
export interface ToolCallContext {
  /** Name of the tool being invoked. */
  toolName: string;
  /** Parameters passed to the tool. */
  params: Record<string, unknown>;
  /** Result of the tool call; only present for post-tool surface. */
  result?: unknown;
}

/**
 * Context for a diff, used by the pre-commit surface detector.
 */
export interface DiffContext {
  /** Raw diff text. */
  diff: string;
  /** Files modified in this diff. */
  changedFiles: string[];
}

/**
 * Context for a full session transcript, used by the post-merge surface detector.
 */
export interface TranscriptContext {
  /** The transcript content. */
  content: string;
  /** Session identifier. */
  sessionId: string;
}

/**
 * Context for a trajectory snapshot, used by the in-flight-checkpoint surface detector.
 */
export interface TrajectoryContext {
  /** Snapshot of recent tool calls and edits. */
  recentSteps: unknown[];
  /** Number of tool calls so far in this session. */
  toolCallCount: number;
}

/**
 * Discriminated union context passed to `Detector.detect()`.
 *
 * The `surface` field determines which optional payload fields are populated.
 * Per mt#1035 §Detector interface.
 */
export type DetectionContext =
  | {
      surface: "pre-tool";
      agentId: string;
      sessionId?: string;
      parentTaskId?: string;
      toolCall: ToolCallContext;
      diff?: undefined;
      transcript?: undefined;
      trajectory?: undefined;
    }
  | {
      surface: "post-tool";
      agentId: string;
      sessionId?: string;
      parentTaskId?: string;
      toolCall: ToolCallContext;
      diff?: undefined;
      transcript?: undefined;
      trajectory?: undefined;
    }
  | {
      surface: "pre-commit";
      agentId: string;
      sessionId?: string;
      parentTaskId?: string;
      toolCall?: undefined;
      diff: DiffContext;
      transcript?: undefined;
      trajectory?: undefined;
    }
  | {
      surface: "post-merge";
      agentId: string;
      sessionId?: string;
      parentTaskId?: string;
      toolCall?: undefined;
      diff?: undefined;
      transcript: TranscriptContext;
      trajectory?: undefined;
    }
  | {
      surface: "in-flight-checkpoint";
      agentId: string;
      sessionId?: string;
      parentTaskId?: string;
      toolCall?: undefined;
      diff?: undefined;
      transcript?: undefined;
      trajectory: TrajectoryContext;
    };

/**
 * All detectors implement this interface.
 *
 * Per mt#1035 §Detector interface.
 */
export interface Detector {
  readonly id: string;
  readonly version: string;
  detect(ctx: DetectionContext): Promise<DetectionSignal[]>;
}

/**
 * Pre-classification intent shape produced by the router-bridge.
 *
 * This is the input contract for the Ask router. It carries all the fields
 * needed to instantiate an `Ask` entity, minus the lifecycle fields (`id`,
 * `state`, `createdAt`, etc.) which the Ask repository fills in on creation.
 *
 * Per ADR-008 §Detection and mt#1035 §Integration with the Ask router.
 */
export interface AskIntent {
  /** Ask kind, from the detector's `suspectedKind`. */
  kind: Extract<AskKind, "direction.decide" | "authorization.approve">;

  /**
   * Version tag of the classifier that produced this intent.
   * Set to `detectorId@detectorVersion` by `signalToAskIntent`.
   */
  classifierVersion: string;

  /** Agent identity of the requestor (the agent that ran the detector). */
  requestor: string;

  /** Short summary for list rendering and notifications. */
  title: string;

  /** The full question body for the resulting Ask. */
  question: string;

  /** Structured decision frame, if provided by the detector. */
  options?: AskOption[];

  /** Context references for the responder. */
  contextRefs?: ContextRef[];

  /** Parent task ID, if the detection occurred in a task-scoped session. */
  parentTaskId?: string;

  /** Parent session ID, if the detection occurred in an active session. */
  parentSessionId?: string;

  /** Additional metadata carried through to the Ask entity. */
  metadata: {
    detectorId: string;
    severity: "low" | "medium" | "high";
    evidence: Evidence[];
    [key: string]: unknown;
  };
}

export type { AskOption, ContextRef };
