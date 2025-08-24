/**
 * Types for context management functionality
 *
 * Includes rule suggestion and context analysis capabilities.
 */

import type { Rule } from "../rules/types";
import type { TokenizerComparison } from "../ai/tokenization/types";

export interface RuleSuggestionRequest {
  query: string;
  workspaceRules: Rule[];
  contextHints: {
    currentFiles?: string[];
    recentCommits?: string[];
    projectType?: string;
  };
}

export interface RuleSuggestionResponse {
  suggestions: Array<{
    ruleId: string;
    relevanceScore: number;
    reasoning: string;
    confidenceLevel: "high" | "medium" | "low";
  }>;
  queryAnalysis: {
    intent: string;
    keywords: string[];
    suggestedCategories: string[];
  };
  totalRulesAnalyzed: number;
  processingTimeMs: number;
}

export interface RuleSuggestion {
  ruleId: string;
  relevanceScore: number;
  reasoning: string;
  confidenceLevel: "high" | "medium" | "low";
  ruleName?: string;
}

export interface QueryAnalysis {
  intent: string;
  keywords: string[];
  suggestedCategories: string[];
}

export interface RuleSuggestionConfig {
  maxSuggestions?: number;
  minRelevanceScore?: number;
  aiProvider?: string;
  aiModel?: string;
}

export class RuleSuggestionError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = "RuleSuggestionError";
  }
}

// Context Analysis Types

export interface ContextElement {
  /** Type of context element */
  type: "rule" | "file" | "conversation" | "metadata" | "other";

  /** Unique identifier for this element */
  id: string;

  /** Human-readable name/title */
  name: string;

  /** Content of the element */
  content: string;

  /** Size information */
  size: {
    /** Character count */
    characters: number;
    /** Line count (for text content) */
    lines?: number;
    /** File size in bytes (for files) */
    bytes?: number;
  };

  /** Metadata about the element */
  metadata?: {
    /** File path (for files) */
    filePath?: string;
    /** Rule ID (for rules) */
    ruleId?: string;
    /** Last modified time */
    lastModified?: Date;
    /** MIME type or content type */
    contentType?: string;
    /** Additional properties */
    [key: string]: any;
  };
}

export interface ContextAnalysisRequest {
  /** Target model for analysis */
  model: string;

  /** Workspace type */
  workspaceType?: "main" | "session";

  /** Specific workspace path */
  workspacePath?: string;

  /** Include specific element types */
  includeTypes?: ContextElement["type"][];

  /** Exclude specific element types */
  excludeTypes?: ContextElement["type"][];

  /** Analysis options */
  options?: {
    /** Include cross-model comparison */
    compareModels?: string[];

    /** Include tokenizer comparison */
    compareTokenizers?: boolean;

    /** Include optimization suggestions */
    includeOptimizations?: boolean;

    /** Enable detailed breakdown */
    detailedBreakdown?: boolean;
  };
}

export interface ContextAnalysisResult {
  /** Summary information */
  summary: {
    /** Total token count for target model */
    totalTokens: number;

    /** Context window utilization percentage */
    utilizationPercentage: number;

    /** Total number of elements */
    totalElements: number;

    /** Total character count */
    totalCharacters: number;

    /** Analysis timestamp */
    timestamp: Date;

    /** Target model analyzed */
    model: string;
  };

  /** Breakdown by element type */
  breakdown: {
    [type in ContextElement["type"]]?: {
      /** Number of elements of this type */
      count: number;

      /** Total tokens for this type */
      tokens: number;

      /** Percentage of total tokens */
      percentage: number;

      /** Total characters */
      characters: number;

      /** Largest element of this type */
      largestElement?: {
        id: string;
        name: string;
        tokens: number;
      };
    };
  };

  /** Individual element analysis */
  elements: Array<{
    element: ContextElement;
    tokenCount: number;
    percentage: number;
    ranking: number;
  }>;

  /** Cross-model comparison (if requested) */
  modelComparison?: Array<{
    model: string;
    tokenCount: number;
    difference: number;
    differencePercentage: number;
  }>;

  /** Tokenizer comparison (if requested) */
  tokenizerComparison?: TokenizerComparison[];

  /** Optimization suggestions */
  optimizations?: Array<{
    type: "remove" | "reduce" | "optimize" | "reorder";
    elementId: string;
    elementName: string;
    currentTokens: number;
    potentialSavings: number;
    description: string;
    confidence: "high" | "medium" | "low";
  }>;

  /** Performance metrics */
  performance: {
    /** Analysis duration in milliseconds */
    analysisTime: number;

    /** Tokenization time in milliseconds */
    tokenizationTime: number;

    /** Context discovery time in milliseconds */
    discoveryTime: number;
  };
}

export interface ContextDiscoveryOptions {
  /** Workspace path to analyze */
  workspacePath?: string;

  /** Include rule files */
  includeRules?: boolean;

  /** Include open/recent files */
  includeFiles?: boolean;

  /** File patterns to include */
  includePatterns?: string[];

  /** File patterns to exclude */
  excludePatterns?: string[];

  /** Maximum file size to include (in bytes) */
  maxFileSize?: number;

  /** Maximum number of files to include */
  maxFiles?: number;
}

export interface ContextVisualizationRequest {
  /** Analysis result to visualize */
  analysisResult: ContextAnalysisResult;

  /** Output format */
  format: "console" | "json" | "csv";

  /** Visualization options */
  options?: {
    /** Show detailed breakdown */
    showBreakdown?: boolean;

    /** Show individual elements */
    showElements?: boolean;

    /** Show optimizations */
    showOptimizations?: boolean;

    /** Show comparisons */
    showComparisons?: boolean;

    /** Chart width for console output */
    chartWidth?: number;

    /** Number of top elements to show */
    topElements?: number;
  };
}

export interface ContextVisualizationResult {
  /** Formatted output */
  output: string;

  /** Format used */
  format: "console" | "json" | "csv";

  /** Generation timestamp */
  timestamp: Date;

  /** Any warnings or notes */
  warnings?: string[];
}

export class ContextAnalysisError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = "ContextAnalysisError";
  }
}
