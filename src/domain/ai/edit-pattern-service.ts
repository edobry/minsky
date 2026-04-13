/**
 * Edit Pattern Service
 *
 * Domain logic for applying AI-powered edit patterns to file content.
 * Handles provider selection (fast-apply vs fallback), prompt construction,
 * completion-service wiring, and error mapping.
 *
 * Used by both session edit tools and task edit tools (via the MCP adapters).
 */
import { EnhancedAICompletionService } from "./enhanced-completion-service";
import { DefaultAICompletionService } from "./completion-service";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { RateLimitError, AuthenticationError, ServerError } from "./enhanced-error-types";
import { first } from "../../utils/array-safety";
import {
  analyzeEditPattern,
  createMorphCompletionParams,
  type MorphFastApplyRequest,
} from "./edit-pattern-utils";
import { getConfiguration } from "../configuration";
import type { Configuration } from "../configuration/schemas/index";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Apply an edit pattern using fast-apply providers with fallback support.
 *
 * Uses AI-powered editing to replace legacy string-based pattern matching.
 * The optional `dependencies.config` is provided for test injection — when
 * omitted, configuration is read from the global configuration service.
 */
export async function applyEditPattern(
  originalContent: string,
  editContent: string,
  instruction?: string,
  dependencies?: {
    config?: Configuration;
  }
): Promise<string> {
  // Get AI configuration (use injected config or fallback to global)
  const config = dependencies?.config || getConfiguration();
  const aiConfig = config.ai;

  if (!aiConfig?.providers) {
    throw new Error("No AI providers configured for edit operations");
  }

  // Analyze edit pattern for validation and optimization
  const analysis = analyzeEditPattern(editContent);
  if (!analysis.validation.isValid) {
    log.warn("Edit pattern validation issues detected", {
      issues: analysis.validation.issues,
      suggestions: analysis.validation.suggestions,
    });
  }

  // Find fast-apply capable provider (currently Morph, extendable to others)
  const fastApplyProviders = Object.entries(aiConfig.providers)
    .filter(
      ([name, providerConfig]) => providerConfig?.enabled && name === "morph" // Add other fast-apply providers here as needed
    )
    .map(([name]) => name);

  let provider: string;
  let model: string | undefined;
  let isFastApply = false;

  if (fastApplyProviders.length > 0) {
    // Use fast-apply provider
    provider = first(fastApplyProviders, "fast-apply providers");
    model = provider === "morph" ? "morph-v3-large" : undefined;
    isFastApply = true;
    log.debug(`Using fast-apply provider: ${provider}`);
  } else {
    // Fallback to default provider
    provider = aiConfig.defaultProvider || "anthropic";

    // Simple fallback - try to find an enabled provider with API key
    const fallbackConfig = aiConfig.providers[provider];
    if (!fallbackConfig?.enabled || !fallbackConfig?.apiKey) {
      // Try Anthropic as ultimate fallback
      provider = "anthropic";
    }

    log.debug(`Fast-apply providers unavailable, using fallback provider: ${provider}`);
  }

  // Create enhanced AI completion service with retry logic and circuit breaker
  const defaultCompletionService = new DefaultAICompletionService({
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  });
  const retryService = new IntelligentRetryService();
  const completionService = new EnhancedAICompletionService(defaultCompletionService, retryService);

  try {
    let completionParams;

    // Use Morph Fast Apply format for fast-apply providers
    if (isFastApply && provider === "morph") {
      const morphRequest: MorphFastApplyRequest = {
        instruction: instruction || "Apply the edit pattern to the original code",
        originalCode: originalContent,
        editPattern: editContent,
      };

      completionParams = createMorphCompletionParams(morphRequest, {
        provider,
        model,
        temperature: 0.1,
        maxTokens: Math.max(originalContent.length * 2, 4000),
      });

      log.debug("Using Morph Fast Apply format", {
        provider,
        model,
        hasMarkers: analysis.hasMarkers,
        markerCount: analysis.markerCount,
        editLength: editContent.length,
      });
    } else {
      // Generic fallback prompt format
      const prompt = `Apply the following edit pattern to the original content:

Original content:
\`\`\`
${originalContent}
\`\`\`

Edit pattern:
\`\`\`
${editContent}
\`\`\`

Instructions:
- Apply the edits shown in the edit pattern to the original content
- The edit pattern uses "// ... existing code ..." markers to indicate unchanged sections
- Return ONLY the complete updated file content
- Preserve all formatting, indentation, and structure
- Do not include explanations or markdown formatting`;

      completionParams = {
        prompt,
        provider,
        model,
        temperature: 0.1, // Low temperature for precise edits
        maxTokens: Math.max(originalContent.length * 2, 4000),
        systemPrompt:
          "You are a precise code editor. Apply the edit pattern exactly as specified and return only the final updated content.",
      };

      log.debug("Using generic edit format", { provider, hasMarkers: analysis.hasMarkers });
    }

    // Generate the edited content using the enhanced completion service
    const response = await completionService.complete(completionParams);
    const result = response.content.trim();

    // Log usage for monitoring
    log.debug(
      `Edit completed using ${isFastApply ? "fast-apply" : "fallback"} provider: ${provider}`,
      {
        provider,
        model,
        originalLength: originalContent.length,
        editLength: editContent.length,
        resultLength: result.length,
        hasMarkers: analysis.hasMarkers,
        markerCount: analysis.markerCount,
      }
    );

    return result;
  } catch (error) {
    // Enhanced error handling and reporting
    if (error instanceof RateLimitError) {
      log.warn(`Rate limit encountered for ${provider}`, {
        provider,
        retryAfter: error.retryAfter,
        remaining: error.remaining,
        limit: error.limit,
        resetTime: error.resetTime,
      });
      // Use the enhanced user-friendly message
      throw new Error(error.getUserFriendlyMessage());
    } else if (error instanceof AuthenticationError) {
      log.error(`Authentication failed for ${provider}`, {
        provider,
        code: error.code,
        type: error.type,
      });
      throw new Error(error.getUserFriendlyMessage());
    } else if (error instanceof ServerError) {
      log.error(`Server error from ${provider}`, {
        provider,
        statusCode: error.statusCode,
        isTransient: error.isTransient,
      });
      throw new Error(`Server error from ${provider} (${error.statusCode}): ${error.message}`);
    } else {
      log.error(`Unexpected error during AI completion`, {
        provider,
        errorType: error instanceof Error ? error.constructor.name : "unknown",
        errorMessage: getErrorMessage(error),
      });
      throw error;
    }
  }
}
