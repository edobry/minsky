/**
 * AI Review Service
 *
 * Provides AI-powered code review capabilities using changeset abstraction.
 * Integrates with the existing AI completion backend to analyze changesets
 * and provide structured feedback across different repository platforms.
 */

import type { ChangesetDetails } from "../changeset/adapter-interface";
import type { AICompletionService, AICompletionRequest, AICompletionResponse } from "./types";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * AI review options for customizing analysis
 */
export interface AIReviewOptions {
  /** AI model to use for analysis */
  model?: string;

  /** Focus area for review */
  focus?: "security" | "performance" | "style" | "logic" | "testing" | "general";

  /** Enable detailed file-level analysis */
  detailed?: boolean;

  /** Include task specification in context */
  includeTaskSpec?: boolean;

  /** Include git history in context */
  includeHistory?: boolean;

  /** AI provider to use */
  provider?: "openai" | "anthropic" | "google" | "cohere" | "mistral";

  /** Temperature for AI model (creativity vs consistency) */
  temperature?: number;

  /** Maximum tokens for response */
  maxTokens?: number;
}

/**
 * Individual file review within a changeset
 */
export interface FileReview {
  /** File path relative to repository root */
  path: string;

  /** Review score for this file (1-10) */
  score: number;

  /** Specific issues found in this file */
  issues: FileIssue[];

  /** Positive observations about this file */
  positives: string[];

  /** Suggestions for improvement */
  suggestions: FileSuggestion[];
}

/**
 * Individual issue found in a file
 */
export interface FileIssue {
  /** Issue severity */
  severity: "info" | "warning" | "error" | "critical";

  /** Issue category */
  category: "security" | "performance" | "style" | "logic" | "testing" | "maintainability";

  /** Human-readable description */
  description: string;

  /** Line number if specific to a line */
  line?: number;

  /** Line range if spanning multiple lines */
  startLine?: number;
  endLine?: number;

  /** Suggested fix if available */
  suggestedFix?: string;
}

/**
 * Suggestion for improving a file
 */
export interface FileSuggestion {
  /** Type of suggestion */
  type: "refactor" | "optimize" | "add_test" | "add_documentation" | "improve_naming";

  /** Description of the suggestion */
  description: string;

  /** Code example if applicable */
  example?: string;

  /** Priority of the suggestion */
  priority: "low" | "medium" | "high";
}

/**
 * Review section for different analysis areas
 */
export interface ReviewSection {
  /** Section name */
  name: string;

  /** Score for this section (1-10) */
  score: number;

  /** Detailed findings */
  findings: string[];

  /** Recommendations for this section */
  recommendations: string[];

  /** Confidence in this section's analysis */
  confidence: number;
}

/**
 * Complete AI review result
 */
export interface AIReviewResult {
  /** Overall analysis summary */
  overall: {
    /** Overall quality score (1-10) */
    score: number;

    /** High-level summary of the review */
    summary: string;

    /** AI recommendation for action */
    recommendation: "approve" | "request_changes" | "comment";

    /** Confidence in the overall assessment */
    confidence: number;
  };

  /** Section-specific analysis */
  sections: {
    [key: string]: ReviewSection;
  };

  /** File-by-file reviews */
  fileReviews: FileReview[];

  /** General suggestions not tied to specific files */
  suggestions: string[];

  /** Metadata about the review process */
  metadata: {
    /** Model used for analysis */
    model: string;

    /** Provider used */
    provider: string;

    /** Time taken for analysis */
    analysisTimeMs: number;

    /** Number of tokens used */
    tokensUsed?: number;

    /** Focus area requested */
    focus: string;

    /** Whether detailed analysis was performed */
    detailed: boolean;
  };
}

/**
 * AI Review Service for analyzing changesets
 */
export class AIReviewService {
  constructor(private completionService: AICompletionService) {}

  /**
   * Review a changeset using AI analysis
   */
  async reviewChangeset(
    changeset: ChangesetDetails,
    options: AIReviewOptions = {}
  ): Promise<AIReviewResult> {
    const startTime = Date.now();

    try {
      log.debug("Starting AI review of changeset", {
        changesetId: changeset.id,
        platform: changeset.platform,
        filesChanged: changeset.diffStats?.filesChanged,
        focus: options.focus || "general",
        model: options.model || "gpt-4o",
      });

      // Build the review prompt based on changeset data
      const prompt = await this.buildReviewPrompt(changeset, options);

      // Create AI completion request
      const completionRequest: AICompletionRequest = {
        provider: options.provider || "openai",
        model: options.model || "gpt-4o",
        prompt: prompt.userPrompt,
        systemPrompt: prompt.systemPrompt,
        temperature: options.temperature || 0.3, // Lower temperature for consistent reviews
        maxTokens: options.maxTokens || 4000,
      };

      // Get AI analysis
      const response = await this.completionService.complete(completionRequest);

      // Parse and structure the response
      const reviewResult = await this.parseAIResponse(response, changeset, options);

      const analysisTime = Date.now() - startTime;

      // Add metadata
      reviewResult.metadata = {
        model: options.model || "gpt-4o",
        provider: options.provider || "openai",
        analysisTimeMs: analysisTime,
        tokensUsed: response.usage?.totalTokens,
        focus: options.focus || "general",
        detailed: options.detailed || false,
      };

      log.debug("AI review completed", {
        changesetId: changeset.id,
        overallScore: reviewResult.overall.score,
        recommendation: reviewResult.overall.recommendation,
        analysisTimeMs: analysisTime,
        tokensUsed: response.usage?.totalTokens,
      });

      return reviewResult;
    } catch (error) {
      log.error("Error during AI review", {
        changesetId: changeset.id,
        error: getErrorMessage(error),
        options,
      });

      // Return a fallback error result
      return this.createErrorResult(error, changeset, options, Date.now() - startTime);
    }
  }

  /**
   * Build AI prompt from changeset data
   */
  private async buildReviewPrompt(
    changeset: ChangesetDetails,
    options: AIReviewOptions
  ): Promise<{ systemPrompt: string; userPrompt: string }> {
    const focus = options.focus || "general";
    const detailed = options.detailed || false;

    // System prompt defines the AI's role and capabilities
    const systemPrompt = this.getSystemPrompt(focus, detailed);

    // User prompt contains the actual changeset data
    const userPrompt = this.buildUserPrompt(changeset, options);

    return { systemPrompt, userPrompt };
  }

  /**
   * Get system prompt based on focus area
   */
  private getSystemPrompt(focus: string, detailed: boolean): string {
    const basePrompt = `You are an expert code reviewer with deep knowledge of software engineering best practices, security, performance optimization, and maintainable code design.

Your task is to analyze code changes and provide structured, actionable feedback. Focus on being constructive and helpful while maintaining high standards.`;

    const focusInstructions = {
      security:
        "Pay special attention to security vulnerabilities, authentication issues, input validation, and potential attack vectors.",
      performance:
        "Focus on performance implications, algorithmic complexity, memory usage, and optimization opportunities.",
      style:
        "Emphasize code style, formatting, naming conventions, documentation, and maintainability.",
      logic:
        "Concentrate on logical correctness, edge cases, error handling, and business logic implementation.",
      testing: "Review test coverage, test quality, edge case handling, and testing strategy.",
      general:
        "Provide balanced feedback covering security, performance, style, logic, and testing aspects.",
    };

    const detailLevel = detailed
      ? "Provide detailed, line-by-line analysis where relevant. Include specific code examples and suggestions."
      : "Provide a balanced overview with specific examples for the most important issues.";

    return `${basePrompt}

${focusInstructions[focus as keyof typeof focusInstructions] || focusInstructions.general}

${detailLevel}

Always provide your response in a structured format with clear scores (1-10 scale), specific findings, and actionable recommendations.`;
  }

  /**
   * Build user prompt with changeset data
   */
  private buildUserPrompt(changeset: ChangesetDetails, options: AIReviewOptions): string {
    const sections = [];

    // Basic changeset information
    sections.push(`## Changeset Overview
- **ID**: ${changeset.id}
- **Platform**: ${changeset.platform}
- **Title**: ${changeset.title}
- **Author**: ${changeset.author.username}
- **Status**: ${changeset.status}
- **Target Branch**: ${changeset.targetBranch} ← ${changeset.sourceBranch || "HEAD"}`);

    // Description
    if (changeset.description && changeset.description.trim()) {
      sections.push(`## Description
${changeset.description}`);
    }

    // Task context if available
    if (changeset.taskId && options.includeTaskSpec) {
      sections.push(`## Task Context
- **Task ID**: ${changeset.taskId}
- **Session**: ${changeset.sessionName || "N/A"}`);
    }

    // Diff statistics
    if (changeset.diffStats) {
      sections.push(`## Change Statistics
- **Files Changed**: ${changeset.diffStats.filesChanged}
- **Lines Added**: ${changeset.diffStats.additions}
- **Lines Deleted**: ${changeset.diffStats.deletions}
- **Net Change**: ${changeset.diffStats.additions - changeset.diffStats.deletions} lines`);
    }

    // Commits
    if (changeset.commits && changeset.commits.length > 0) {
      sections.push(`## Commits (${changeset.commits.length})
${changeset.commits
  .map(
    (commit) =>
      `- \`${commit.sha.substring(0, 7)}\` ${commit.message.split("\n")[0]} (${commit.author.username})`
  )
  .join("\n")}`);
    }

    // File changes
    if (changeset.files && changeset.files.length > 0) {
      const filesList = changeset.files
        .slice(0, 20)
        .map((file) => {
          const statusIcon = {
            added: "🟢",
            modified: "🟡",
            deleted: "🔴",
            renamed: "🔄",
            copied: "📋",
          };

          return `- ${statusIcon[file.status] || "📝"} \`${file.path}\` (+${file.additions}/-${file.deletions})`;
        })
        .join("\n");

      const truncated =
        changeset.files.length > 20 ? `\n... and ${changeset.files.length - 20} more files` : "";

      sections.push(`## File Changes${truncated}
${filesList}`);
    }

    // Code diff (truncated for token limits)
    if (changeset.fullDiff && changeset.fullDiff.trim()) {
      const diffLines = changeset.fullDiff.split("\n");
      const truncatedDiff =
        diffLines.length > 500
          ? `${diffLines.slice(0, 500).join("\n")}\n\n[... diff truncated for length ...]`
          : changeset.fullDiff;

      sections.push(`## Code Changes
\`\`\`diff
${truncatedDiff}
\`\`\``);
    }

    // Existing reviews if any
    if (changeset.reviews && changeset.reviews.length > 0) {
      const reviewsSummary = changeset.reviews
        .map(
          (review) =>
            `- **${review.author.username}**: ${review.status} - ${review.summary || "No summary"}`
        )
        .join("\n");

      sections.push(`## Existing Reviews
${reviewsSummary}`);
    }

    // Analysis request
    const focus = options.focus || "general";
    sections.push(`## Please Analyze
Provide a comprehensive code review focusing on **${focus}** aspects. Include:

1. **Overall Assessment**: Score (1-10) and recommendation (approve/request_changes/comment)
2. **Key Findings**: Most important issues or positive observations
3. **File-Specific Feedback**: Issues and suggestions for individual files
4. **Actionable Recommendations**: Specific next steps for improvement

Focus on being constructive and helpful while maintaining high standards.`);

    return sections.join("\n\n");
  }

  /**
   * Parse AI response into structured format
   */
  private async parseAIResponse(
    response: AICompletionResponse,
    changeset: ChangesetDetails,
    options: AIReviewOptions
  ): Promise<AIReviewResult> {
    // For now, implement basic parsing. This could be enhanced with structured output
    const text = response.text;

    // Extract overall score and recommendation using pattern matching
    const scoreMatch = text.match(/(?:score|rating|overall).*?(\d+)(?:\/10|\s*out\s*of\s*10)?/i);
    const overallScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 7; // Default to 7

    // Determine recommendation based on score and text content
    let recommendation: "approve" | "request_changes" | "comment" = "comment";
    if (overallScore >= 8) {
      recommendation = "approve";
    } else if (
      overallScore <= 5 ||
      text.toLowerCase().includes("request") ||
      text.toLowerCase().includes("concern")
    ) {
      recommendation = "request_changes";
    }

    // Extract key findings and summary
    const summary = this.extractSummary(text);
    const findings = this.extractFindings(text);

    // Create file reviews based on mentioned files
    const fileReviews = this.extractFileReviews(text, changeset.files || []);

    // Build sections based on focus area
    const sections = this.extractSections(text, options.focus || "general");

    return {
      overall: {
        score: Math.max(1, Math.min(10, overallScore)), // Clamp to 1-10 range
        summary,
        recommendation,
        confidence: 0.8, // Default confidence
      },
      sections,
      fileReviews,
      suggestions: findings,
      metadata: {
        model: options.model || "gpt-4o",
        provider: options.provider || "openai",
        analysisTimeMs: 0, // Will be set by caller
        focus: options.focus || "general",
        detailed: options.detailed || false,
      },
    };
  }

  /**
   * Extract summary from AI response
   */
  private extractSummary(text: string): string {
    const summaryPatterns = [
      /## Overall Assessment\n(.*?)(?=\n##|\n\n|$)/s,
      /## Summary\n(.*?)(?=\n##|\n\n|$)/s,
      /Overall.*?\n(.*?)(?=\n##|\n\n|$)/s,
    ];

    for (const pattern of summaryPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim().substring(0, 500); // Limit length
      }
    }

    // Fallback: use first paragraph
    const firstParagraph = text.split("\n\n")[0];
    return firstParagraph.substring(0, 300) || "AI analysis completed.";
  }

  /**
   * Extract key findings from AI response
   */
  private extractFindings(text: string): string[] {
    const findings: string[] = [];

    // Look for bullet points or numbered lists
    const bulletPattern = /^[\s]*[•\-\*]\s+(.+)$/gm;
    const numberPattern = /^[\s]*\d+\.\s+(.+)$/gm;

    let match;
    while ((match = bulletPattern.exec(text)) !== null) {
      if (match[1] && match[1].length > 10) {
        findings.push(match[1].trim());
      }
    }

    while ((match = numberPattern.exec(text)) !== null) {
      if (match[1] && match[1].length > 10) {
        findings.push(match[1].trim());
      }
    }

    return findings.slice(0, 10); // Limit to top 10 findings
  }

  /**
   * Extract file-specific reviews
   */
  private extractFileReviews(text: string, files: { path: string }[]): FileReview[] {
    const fileReviews: FileReview[] = [];

    // Simple pattern matching for file mentions
    for (const file of files.slice(0, 10)) {
      // Limit to first 10 files
      const fileName = file.path.split("/").pop() || file.path;
      const filePattern = new RegExp(`${fileName}.*?(?=(?:\\n\\n|$))`, "gi");
      const match = text.match(filePattern);

      if (match) {
        fileReviews.push({
          path: file.path,
          score: 7, // Default score
          issues: [],
          positives: [],
          suggestions: [],
        });
      }
    }

    return fileReviews;
  }

  /**
   * Extract sections based on focus area
   */
  private extractSections(text: string, focus: string): { [key: string]: ReviewSection } {
    const sections: { [key: string]: ReviewSection } = {};

    // Create a section for the focus area
    sections[focus] = {
      name: focus.charAt(0).toUpperCase() + focus.slice(1),
      score: 7, // Default
      findings: this.extractFindings(text),
      recommendations: [],
      confidence: 0.8,
    };

    return sections;
  }

  /**
   * Create error result when AI analysis fails
   */
  private createErrorResult(
    error: any,
    changeset: ChangesetDetails,
    options: AIReviewOptions,
    analysisTimeMs: number
  ): AIReviewResult {
    return {
      overall: {
        score: 5, // Neutral score for errors
        summary: `AI review failed: ${getErrorMessage(error)}. Manual review recommended.`,
        recommendation: "comment",
        confidence: 0.1,
      },
      sections: {},
      fileReviews: [],
      suggestions: ["AI analysis encountered an error. Please perform manual review."],
      metadata: {
        model: options.model || "gpt-4o",
        provider: options.provider || "openai",
        analysisTimeMs,
        focus: options.focus || "general",
        detailed: options.detailed || false,
      },
    };
  }
}
