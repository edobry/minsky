/**
 * Core context generation logic
 *
 * Handles component processing and context assembly.
 */

import { log } from "@minsky/shared/logger";
import { getContextComponentRegistry } from "@minsky/domain/context/components/index";
import { DefaultTokenizationService } from "@minsky/domain/ai/tokenization/index";
import type { GenerateRequest, GenerateResult } from "./generate-types";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * The subset of the tokenization service this module reads.
 *
 * Declared structurally so a test can supply a stub — including one that
 * throws — instead of standing up the real tokenizer registry.
 */
export interface TokenCounter {
  countTokens(text: string, model: string): Promise<number>;
}

/**
 * Divisor for the character-count fallback, used only when tokenization fails.
 *
 * This was the PRIMARY token count until mt#3458. Every component's
 * `token_count` came from it while the analysis screen re-counted the same text
 * with the real tokenizer, so the breakdown divided real counts by an estimated
 * total and percentages exceeded 100% (104% for a single component; 121% for
 * two). It survives as a fallback because a tokenizer failure should degrade the
 * count, not fail the generation — and when it fires the component is named in
 * `metadata.tokenCountFallbacks` rather than passing as a measurement.
 */
export const FALLBACK_CHARS_PER_TOKEN = 4;

function estimateTokensFromLength(text: string): number {
  return Math.floor(text.length / FALLBACK_CHARS_PER_TOKEN);
}

/**
 * Get default components to include
 */
export function getDefaultComponents(): string[] {
  return [
    "environment",
    "workspace-rules",
    "system-instructions",
    "communication",
    "tool-calling-rules",
    "maximize-parallel-tool-calls",
    "maximize-context-understanding",
    "making-code-changes",
    "code-citation-format",
    "task-management",
    "tool-schemas",
    "project-context",
    "session-context",
  ];
}

/**
 * Generate context using the modular component system
 */
export async function generateContext(
  request: GenerateRequest,
  /** Test seam; production callers omit it and get the real tokenizer registry. */
  tokenCounter: TokenCounter = new DefaultTokenizationService()
): Promise<GenerateResult> {
  const startTime = Date.now();
  const registry = getContextComponentRegistry();
  const components = registry.getWithDependencies(request.components);
  const targetModel = request.input.targetModel;
  const tokenCountFallbacks: string[] = [];

  /**
   * Counting failure degrades this one count; it must not fail the generation,
   * whose output is still useful without an exact token figure.
   */
  const countTokens = async (text: string, label: string): Promise<number> => {
    try {
      return await tokenCounter.countTokens(text, targetModel);
    } catch (error) {
      tokenCountFallbacks.push(label);
      log.warn("Tokenization failed; falling back to a character-count estimate", {
        label,
        model: targetModel,
        error: getLoggableErrorSummary(error),
      });
      return estimateTokensFromLength(text);
    }
  };

  const outputs: Array<{
    component_id: string;
    content: string;
    generated_at: string;
    token_count?: number;
  }> = [];

  const skipped: string[] = [];
  const errors: string[] = [];

  // Process each component
  for (const component of components) {
    try {
      log.debug(`Generating component: ${component.id}`);

      // Use new split architecture if available, fallback to legacy generate
      let output;
      if (component.gatherInputs && component.render) {
        const gatheredInputs = await component.gatherInputs(request.input);
        output = component.render(gatheredInputs, request.input);
      } else if (component.generate) {
        output = await component.generate(request.input);
      } else {
        throw new Error(`Component ${component.id} has no generation method`);
      }

      const tokenCount = await countTokens(output.content, component.id);

      outputs.push({
        component_id: component.id,
        content: output.content,
        generated_at: output.metadata?.generatedAt || new Date().toISOString(),
        token_count: tokenCount,
      });

      log.debug(`Component ${component.id} generated successfully`, {
        tokens: tokenCount,
        length: output.content.length,
      });
    } catch (error) {
      const errorMsg = `Failed to generate component ${component.id}: ${error instanceof Error ? error.message : String(error)}`;
      log.error(errorMsg, { error });
      errors.push(errorMsg);
      skipped.push(component.id);
    }
  }

  const generationTime = Date.now() - startTime;
  const totalTokens = outputs.reduce((sum, o) => sum + (o.token_count || 0), 0);

  // Create combined text output
  let content: string;
  if (outputs.length > 0) {
    const sections = outputs.map((o) => o.content);
    content = [
      "# Generated AI Context",
      "",
      `Generated at: ${new Date().toISOString()}`,
      "",
      `Components: ${outputs.map((o) => o.component_id).join(", ")}`,
      "",
      `Template: ${request.input.targetModel ? "model-specific" : "default"}`,
      "",
      `Target Model: ${request.input.targetModel}`,
      "",
      `Interface: ${request.input.interfaceConfig?.interface || "cli"}`,
      "",
      ...sections,
    ].join("\n\n");
  } else {
    content = "# No Context Generated\n\nAll components failed to generate content.";
  }

  /**
   * The assembly header above (`# Generated AI Context`, `Generated at:`, the
   * component list, the model and interface lines) belongs to no component, so
   * it is absent from `totalTokens`. Counting the assembled string separately
   * keeps that gap visible rather than leaving `Total Tokens` quietly short of
   * the context an operator would actually paste (mt#3458).
   */
  const assembledTokens = await countTokens(content, "<assembled context>");

  return {
    content,
    components: outputs,
    metadata: {
      generationTime,
      totalTokens,
      assembledTokens,
      tokenizedForModel: targetModel,
      tokenCountFallbacks,
      skipped,
      errors,
    },
  };
}
