/**
 * Cognition Provider domain types.
 *
 * Domain-layer abstraction for cognitive work — criterion evaluation,
 * narrative synthesis, semantic judgment. Features consume `CognitionProvider`
 * instead of importing `AICompletionService` directly.
 *
 * Canonical design: `docs/architecture/adr-007-cognition-provider-abstraction.md`.
 */

import type { ZodType } from "zod";

/**
 * Advisory model selection hint. Providers MAY honor the hint but are not
 * required to; delegated mode in particular cannot guarantee a specific model.
 */
export interface ModelHint {
  provider?: string;
  model?: string;
}

/**
 * Pure declaration of cognitive work.
 *
 * A task describes what the model should produce — prompts, evidence, and the
 * expected output schema — without coupling to how it will be executed. Tasks
 * are portable across execution modes (direct, delegated, degraded).
 */
export interface CognitionTask<T> {
  /** Stable identifier for correlating results — required for delegated mode. */
  id: string;
  /** Task kind (e.g., `"evaluate-criterion"`, `"synthesize-narrative"`). */
  kind: string;
  systemPrompt: string;
  userPrompt: string;
  /** Structured input referenced by the prompts. Serialized into the LLM input by direct providers. */
  evidence: Record<string, unknown>;
  /** Zod schema describing the expected output shape. */
  schema: ZodType<T>;
  /** Advisory model hint. */
  model?: ModelHint;
}

/**
 * Bundle of tasks for external execution by a surrounding agent (delegated mode).
 */
export interface CognitionBundle {
  /** Stable identifier for the bundle as a unit. */
  id: string;
  tasks: CognitionTask<unknown>[];
  order: "parallel" | "sequential";
  /** Free-form guidance for the executing harness. */
  contextHint?: string;
}

/**
 * Wrapped outcome of a cognitive request. Providers return exactly one kind:
 *
 * - `completed` — the work ran; `value` is the schema-validated output.
 * - `packaged` — the work was bundled for the surrounding agent to execute.
 * - `unavailable` — no cognition available; caller must supply a fallback.
 *
 * Callers must handle all three kinds (enforced by the discriminated union).
 */
export type CognitionResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "packaged"; bundle: CognitionBundle }
  | { kind: "unavailable"; reason: string };

/**
 * Tuple map used by `performBatch` to preserve per-task output types across
 * a heterogeneous batch. For each task in `Ts`, extract its `T` parameter.
 */
export type CognitionBatchValues<Ts extends readonly CognitionTask<unknown>[]> = {
  [K in keyof Ts]: Ts[K] extends CognitionTask<infer R> ? R : never;
};

/**
 * First-class abstraction for cognitive work. Peer of `PersistenceProvider`
 * (ADR-002) and `RepositoryBackend` (ADR-003).
 *
 * Features consume a resolved `CognitionProvider` from the composition root;
 * concrete implementations decide how tasks execute (direct API call, bundled
 * for external execution, unavailable).
 */
export interface CognitionProvider {
  perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>>;
  /**
   * Execute a batch of tasks. Per-task output types are preserved via tuple
   * inference — callers should pass `as const` tuples to retain individual
   * types, otherwise the array widens to the union.
   */
  performBatch<Ts extends readonly CognitionTask<unknown>[]>(
    tasks: Ts
  ): Promise<CognitionResult<CognitionBatchValues<Ts>>>;
}

/**
 * Base error for cognitive execution failures. Providers throw subclasses of
 * this (not the underlying infrastructure error) so callers can reason about
 * the abstraction boundary without importing infra types.
 */
export class CognitionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CognitionError";
  }
}

/**
 * Raised by `DirectCognitionProvider` when the wrapped `AICompletionService`
 * fails. The original error is preserved as `cause`.
 */
export class CognitionExecutionError extends CognitionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CognitionExecutionError";
  }
}

/**
 * Raised when the AI service returns a value that doesn't conform to the
 * task's Zod schema. The underlying `ZodError` is preserved as `cause` so
 * callers can still introspect the validation failure if needed.
 */
export class CognitionValidationError extends CognitionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CognitionValidationError";
  }
}

/**
 * Raised when a task's `evidence` cannot be serialized for inclusion in the
 * LLM request (e.g., circular references, BigInt values). The underlying
 * serialization error is preserved as `cause`.
 */
export class CognitionEvidenceSerializationError extends CognitionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CognitionEvidenceSerializationError";
  }
}
