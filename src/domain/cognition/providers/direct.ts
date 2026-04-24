/**
 * DirectCognitionProvider — wraps `AICompletionService` for standalone execution.
 *
 * Tasks run immediately against the configured AI provider. Output is validated
 * against the task's Zod schema before being returned.
 *
 * Used when Minsky runs standalone with a configured AI provider. Composition-
 * root resolution lives in mt#1186 (mt#1057.C); this subtask only provides the
 * class and accepts the service via constructor injection.
 *
 * ## Error boundary
 *
 * Expected failure paths are wrapped as `CognitionError` subclasses:
 *
 * - `CognitionEvidenceSerializationError` — `JSON.stringify(task.evidence)` threw
 *   (circular references, BigInt, etc.).
 * - `CognitionExecutionError` — the wrapped `AICompletionService` threw an
 *   `AICompletionError`.
 * - `CognitionValidationError` — the service returned a value that failed
 *   `schema.parse` with a `ZodError`.
 *
 * Unexpected errors — i.e., non-`AICompletionError` throws from the service
 * and non-`ZodError` throws from `schema.parse` — pass through unchanged so
 * genuine bugs (programming errors, unexpected runtime failures) aren't
 * silently masked by the abstraction. Callers who want a catch-all boundary
 * must handle both `CognitionError` and `unknown`.
 */

import { ZodError } from "zod";

import type { AICompletionService, AIObjectGenerationRequest } from "../../ai/types";
import { AICompletionError } from "../../ai/types";
import type {
  CognitionBatchValues,
  CognitionProvider,
  CognitionResult,
  CognitionTask,
} from "../types";
import {
  CognitionEvidenceSerializationError,
  CognitionExecutionError,
  CognitionValidationError,
} from "../types";

/**
 * Subset of `AICompletionService` that the direct provider actually consumes.
 * Keeping the dependency narrow simplifies testing and signals that only the
 * schema-validated object path is in play here.
 */
type CognitionAIDependency = Pick<AICompletionService, "generateObject">;

export class DirectCognitionProvider implements CognitionProvider {
  constructor(private readonly ai: CognitionAIDependency) {}

  async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
    const value = await this.executeTask(task);
    return { kind: "completed", value };
  }

  async performBatch<Ts extends readonly CognitionTask<unknown>[]>(
    tasks: Ts
  ): Promise<CognitionResult<CognitionBatchValues<Ts>>> {
    const values = await Promise.all(tasks.map((task) => this.executeTask(task)));
    return {
      kind: "completed",
      value: values as CognitionBatchValues<Ts>,
    };
  }

  private async executeTask<T>(task: CognitionTask<T>): Promise<T> {
    const request = this.buildRequest(task);

    let raw: unknown;
    try {
      raw = await this.ai.generateObject(request);
    } catch (err) {
      if (err instanceof AICompletionError) {
        throw new CognitionExecutionError(
          `CognitionTask "${task.id}" (${task.kind}) failed: ${err.message}`,
          { cause: err }
        );
      }
      throw err;
    }

    try {
      return task.schema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new CognitionValidationError(
          `CognitionTask "${task.id}" (${task.kind}) output failed schema validation: ${err.message}`,
          { cause: err }
        );
      }
      throw err;
    }
  }

  private buildRequest<T>(task: CognitionTask<T>): AIObjectGenerationRequest {
    let serialized: string;
    try {
      serialized = JSON.stringify(task.evidence, null, 2);
    } catch (err) {
      throw new CognitionEvidenceSerializationError(
        `CognitionTask "${task.id}" (${task.kind}) evidence could not be serialized: ${(err as Error).message}`,
        { cause: err }
      );
    }

    // Omit the block when the serialized JSON is semantically empty — this
    // catches both `{}` and inputs where every value was non-serializable
    // (undefined, functions, symbols) and got dropped by JSON.stringify.
    const userContent =
      serialized === "{}"
        ? task.userPrompt
        : `${task.userPrompt}\n\n<evidence>\n${serialized}\n</evidence>`;

    return {
      messages: [
        { role: "system", content: task.systemPrompt },
        { role: "user", content: userContent },
      ],
      schema: task.schema,
      provider: task.model?.provider,
      model: task.model?.model,
    };
  }
}
