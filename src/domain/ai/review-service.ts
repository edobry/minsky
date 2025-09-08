import {
  AICompletionService,
  AICompletionResponse,
  AIModel,
  AIProviderConfig,
  AICompletionError,
  AIProviderError,
  ValidationResult,
  AIUsage,
} from "./types";
import { ChangesetDetails, ChangesetReview, ReviewComment } from "../changeset/adapter-interface";
import { log } from "../../utils/logger";
import { DefaultAIConfigurationService } from "./config-service";
import { ConfigurationService } from "../configuration/types";
import { generateObject } from "ai"; // Using generateObject for structured output
import { openai } from "@ai-sdk/openai"; // Example provider
import { z } from "zod";

// Zod schemas for AI review result validation
const AIReviewResultSchema = z.object({
  overall: z.object({
    score: z.number().int().min(1).max(10),
    recommendation: z.enum(["approve", "request_changes", "needs_review"]),
    summary: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  suggestions: z.array(z.string()).optional(),
  fileReviews: z
    .array(
      z.object({
        path: z.string(),
        score: z.number().int().min(1).max(10),
        issues: z.array(z.string()),
        suggestions: z.array(z.string()),
      })
    )
    .optional(),
  metadata: z.object({
    model: z.string(),
    provider: z.string(),
    focus: z.string(),
    analysisTimeMs: z.number(),
    tokenUsage: z
      .object({
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .optional(),
  }),
});

export type AIReviewResult = z.infer<typeof AIReviewResultSchema>;

export interface ReviewSection {
  title: string;
  content: string;
}

export interface FileReview {
  path: string;
  score: number;
  issues: string[];
  suggestions: string[];
}

export interface Suggestion {
  type: "security" | "performance" | "style" | "logic" | "testing" | "general";
  message: string;
  severity: "low" | "medium" | "high";
  file?: string;
  line?: number;
}

export interface AIReviewOptions {
  model?: string;
  provider?: string;
  focus: "security" | "performance" | "style" | "logic" | "testing" | "general";
  detailed: boolean;
  includeTaskSpec: boolean;
  includeHistory: boolean;
  temperature?: number;
  maxTokens?: number;
}

export class AIReviewService {
  constructor(private completionService: AICompletionService) {}

  async reviewChangeset(
    changeset: ChangesetDetails,
    options: AIReviewOptions
  ): Promise<AIReviewResult> {
    const startTime = Date.now();
    const prompt = this.buildReviewPrompt(changeset, options);

    log.debug("Sending AI review request", {
      model: options.model,
      provider: options.provider,
      focus: options.focus,
      detailed: options.detailed,
    });

    try {
      const aiResponse = await this.completionService.generateObject({
        model: options.model || "gpt-4o", // Default model
        provider: options.provider || "openai", // Default provider
        prompt: prompt,
        schema: AIReviewResultSchema, // Zod schema for validation
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      });

      const duration = Date.now() - startTime;
      log.debug("AI review completed", { duration, usage: aiResponse.usage });

      return {
        ...aiResponse.object,
        metadata: {
          model: options.model || "gpt-4o",
          provider: options.provider || "openai",
          focus: options.focus,
          analysisTimeMs: duration,
          tokenUsage: aiResponse.usage,
        },
      };
    } catch (error) {
      log.error("AI review failed", { error });
      throw new Error(`AI review failed: ${error.message}`);
    }
  }

  private buildReviewPrompt(changeset: ChangesetDetails, options: AIReviewOptions): string {
    const sections: string[] = [];

    sections.push("You are an expert code reviewer. Please analyze the following changeset.");
    sections.push("");

    // Basic changeset information
    sections.push("## Changeset Information");
    sections.push(`**Title:** ${changeset.title || "No title provided"}`);
    sections.push(`**Description:** ${changeset.description || "No description provided"}`);
    sections.push(
      `**Author:** ${changeset.author?.displayName || changeset.author?.username || "Unknown"}`
    );
    sections.push(`**Status:** ${changeset.status}`);

    if (changeset.diffStats) {
      sections.push("");
      sections.push("## Diff Statistics");
      sections.push(`- Files changed: ${changeset.diffStats.filesChanged}`);
      sections.push(`- Lines added: ${changeset.diffStats.additions}`);
      sections.push(`- Lines deleted: ${changeset.diffStats.deletions}`);
    }

    if (changeset.reviews && changeset.reviews.length > 0) {
      sections.push("");
      sections.push("## Existing Reviews");
      changeset.reviews.forEach((review, i) => {
        sections.push(
          `${i + 1}. **${review.author.displayName || review.author.username}**: ${review.status} - ${review.summary || "No summary"}`
        );
      });
    }

    // Add diff content (truncated if too long)
    if (changeset.fullDiff) {
      sections.push("");
      sections.push("## Code Changes");
      sections.push("```diff");

      // Truncate diff if it's too long (keep within reasonable token limits)
      const maxDiffLength = options.maxTokens ? Math.floor(options.maxTokens * 0.6) : 2000;
      const diff =
        changeset.fullDiff.length > maxDiffLength
          ? `${changeset.fullDiff.substring(0, maxDiffLength)}\n... (diff truncated for token limit)`
          : changeset.fullDiff;

      sections.push(diff);
      sections.push("```");
    }

    // Focus area specific instructions
    sections.push("");
    sections.push("## Review Focus");
    switch (options.focus) {
      case "security":
        sections.push(
          "Focus specifically on security vulnerabilities, authentication issues, input validation, and potential exploits."
        );
        break;
      case "performance":
        sections.push(
          "Focus on performance implications, algorithmic complexity, resource usage, and optimization opportunities."
        );
        break;
      case "style":
        sections.push(
          "Focus on code style, formatting, naming conventions, and adherence to best practices."
        );
        break;
      case "logic":
        sections.push(
          "Focus on business logic correctness, edge cases, error handling, and logical flow."
        );
        break;
      case "testing":
        sections.push(
          "Focus on test coverage, test quality, testability of changes, and testing strategies."
        );
        break;
      case "general":
      default:
        sections.push(
          "Provide a comprehensive review covering all aspects: security, performance, style, logic, and testing."
        );
        break;
    }

    // Output format instructions
    sections.push("");
    sections.push("## Required Output Format");
    sections.push("Provide your review as a structured response with the following format:");
    sections.push(
      "- overall: score (1-10), recommendation (approve/request_changes/needs_review), summary, confidence (0-1)"
    );
    sections.push("- suggestions: array of actionable improvement suggestions");
    if (options.detailed) {
      sections.push("- fileReviews: detailed per-file analysis with scores and specific issues");
    }
    sections.push("");
    sections.push("Be specific, constructive, and focus on actionable feedback.");

    return sections.join("\n");
  }
}
