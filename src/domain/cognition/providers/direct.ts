/**
 * DirectCognitionProvider — wraps `AICompletionService` for standalone execution.
 *
 * Tasks run immediately against the configured AI provider. Output is validated
 * against the task's Zod schema before being returned.
 *
 * Used when Minsky runs standalone with a configured AI provider. Composition-
 * root resolution lives in mt#1186 (mt#1057.C); this subtask only provides the
 * class and accepts the service via constructor injection.
 */

import type { AICompletionService, AIObjectGenerationRequest } from "../../ai/types";
import { AICompletionError } from "../../ai/types";
import type {
  CognitionBatchValues,
  CognitionProvider,
  CognitionResult,
  CognitionTask,
} from "../types";
import { CognitionExecutionError } from "../types";

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
    return task.schema.parse(raw);
  }

  private buildRequest<T>(task: CognitionTask<T>): AIObjectGenerationRequest {
    const hasEvidence = Object.keys(task.evidence).length > 0;
    const userContent = hasEvidence
      ? `${task.userPrompt}\n\n<evidence>\n${JSON.stringify(task.evidence, null, 2)}\n</evidence>`
      : task.userPrompt;

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
