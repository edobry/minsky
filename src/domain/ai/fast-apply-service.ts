/**
 * Fast-Apply Service
 *
 * Domain logic for fast-apply operations: provider auto-detection,
 * prompt building, and edit execution.
 */

import type { ResolvedConfig } from "../configuration/types";
import type { AICompletionResponse } from "./types";
import { createCompletionService } from "./service-factory";

export interface FastApplyRequest {
  filePath: string;
  originalContent: string;
  instructions?: string;
  codeEdit?: string;
  provider?: string;
  model?: string;
}

export interface FastApplyResult {
  editedContent: string;
  mode: string;
  provider: string;
  response: AICompletionResponse;
}

/**
 * Auto-detect a fast-apply capable provider from configuration.
 * Returns the provider name or null if none found.
 */
export function detectFastApplyProvider(config: ResolvedConfig): string | null {
  const providers = config.ai?.providers;
  if (!providers) return null;

  const fastApplyProviders = Object.entries(providers)
    .filter(([name, providerConfig]) => providerConfig?.enabled && name === "morph")
    .map(([name]) => name);

  return fastApplyProviders[0] ?? null;
}

/**
 * Build a fast-apply prompt based on the edit mode.
 */
export function buildFastApplyPrompt(
  originalContent: string,
  instructions?: string,
  codeEdit?: string
): { prompt: string; mode: string } {
  if (codeEdit) {
    const editInstructions =
      instructions || "I am applying the provided code edits with existing code markers";
    return {
      prompt: `<instruction>${editInstructions}</instruction>
<code>${originalContent}</code>
<update>${codeEdit}</update>`,
      mode: "Cursor edit pattern",
    };
  }

  return {
    prompt: `<instruction>${instructions}</instruction>
<code>${originalContent}</code>
<update>// Apply the above instructions to modify this file</update>`,
    mode: "instruction-based",
  };
}

/**
 * Execute a fast-apply operation, returning the edited content.
 */
export async function executeFastApply(
  config: ResolvedConfig,
  request: FastApplyRequest
): Promise<FastApplyResult> {
  const { originalContent, instructions, codeEdit, model } = request;
  let targetProvider = request.provider;

  if (!targetProvider) {
    targetProvider = detectFastApplyProvider(config) ?? undefined;
    if (!targetProvider) {
      throw new Error(
        "No fast-apply capable providers configured. " +
          "Please configure Morph or another fast-apply provider."
      );
    }
  }

  const { prompt, mode } = buildFastApplyPrompt(originalContent, instructions, codeEdit);

  const completionService = createCompletionService(config);

  const response = await completionService.complete({
    prompt,
    provider: targetProvider,
    model: model || (targetProvider === "morph" ? "morph-v3-large" : undefined),
    temperature: 0.1,
    maxTokens: Math.max(originalContent.length * 2, 4000),
    systemPrompt:
      "You are a precise code editor. Return only the final updated " +
      "file content without any explanations or formatting.",
  });

  return {
    editedContent: response.content.trim(),
    mode,
    provider: targetProvider,
    response,
  };
}
