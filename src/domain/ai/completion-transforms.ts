/**
 * AI Completion Transforms
 *
 * Pure utility functions for transforming Vercel AI SDK responses
 * into the internal AICompletionResponse format.
 */

import { AIUsage, AICompletionError, AIProviderError } from "./types";

/**
 * Transform Vercel AI SDK usage object to internal AIUsage format.
 */
export function transformUsage(usage: {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}): AIUsage {
  return {
    promptTokens: usage?.promptTokens || 0,
    completionTokens: usage?.completionTokens || 0,
    totalTokens: usage?.totalTokens || 0,
    cost: usage?.cost,
  };
}

/**
 * Map a Vercel AI SDK finish reason string to the internal union type.
 */
export function mapFinishReason(reason: string): "stop" | "length" | "tool-calls" | "error" {
  const reasonMap: Record<string, "stop" | "length" | "tool-calls" | "error"> = {
    stop: "stop",
    length: "length",
    "tool-calls": "tool-calls",
    error: "error",
    unknown: "stop",
  };

  return reasonMap[reason] ?? "stop";
}

/**
 * Transform any thrown value into a typed AICompletionError or AIProviderError.
 */
export function transformError(error: unknown, provider?: string, model?: string): Error {
  if (error instanceof AICompletionError || error instanceof AIProviderError) {
    return error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const resolvedProvider = provider || "unknown";
  const resolvedModel = model || "unknown";

  if (errorMessage.includes("API key") || errorMessage.includes("authentication")) {
    return new AIProviderError(
      `Authentication failed for ${resolvedProvider}: ${errorMessage}`,
      resolvedProvider,
      "AUTHENTICATION_ERROR",
      { originalError: error }
    );
  }

  if (errorMessage.includes("rate limit") || errorMessage.includes("quota")) {
    return new AIProviderError(
      `Rate limit exceeded for ${resolvedProvider}: ${errorMessage}`,
      resolvedProvider,
      "RATE_LIMIT_ERROR",
      { originalError: error }
    );
  }

  if (errorMessage.includes("model") && errorMessage.includes("not found")) {
    return new AICompletionError(
      `Model ${resolvedModel} not found for provider ${resolvedProvider}: ${errorMessage}`,
      resolvedProvider,
      resolvedModel,
      "MODEL_NOT_FOUND",
      { originalError: error }
    );
  }

  return new AICompletionError(
    `AI completion failed: ${errorMessage}`,
    resolvedProvider,
    resolvedModel,
    "COMPLETION_ERROR",
    { originalError: error }
  );
}
