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
  contextHints?: {
    currentFiles?: string[];
    recentCommits?: string[];
    projectType?: string;
    workspacePath?: string;
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
    public details?: unknown
  ) {
    super(message);
    this.name = "RuleSuggestionError";
  }
}

// Context Analysis Types
//
// Canonical harness-agnostic context-analysis shapes. Originally designed during the
// Cursor-cannibalization era (mt#082 → mt#461) but never adopted by the synthesis path
// (`src/commands/context/`), which defines its own `AnalysisResult` shape in
// `generate-types.ts`. mt#2033 (Path A) makes these canonical shapes load-bearing for
// the first time by adopting them in the observation path (mt#2022 onward).
//
// Two consumers, two source values for the `ContextAnalysisResult.source` discriminator:
//   - "synthesized" — "what context should be assembled from current workspace state"
//                     (synthesis path; not yet migrated to these types — see mt#2040)
//   - "observed"    — "what context actually was during a specific harness session"
//                     (observation path; mt#2022 adopts this surface)
//
// The diff between the two surfaces (mt#2039) exposes harness-specific overhead.
// Synthesis-path migration to the canonical shape is filed as mt#2040 (Path B follow-up).

export interface ContextElement {
  /**
   * Type of context element.
   *
   * Synthesis-path kinds (Cursor-replication era + general): rule / file / conversation
   * / metadata / other.
   *
   * Observation-path kinds (per-harness reality): hook-injection / skill-body /
   * tool-result / tool-schema / deferred-tool-catalog / mcp-instructions / system-prompt
   * / user-prompt / assistant-text / assistant-thinking.
   */
  type: // Synthesis-path kinds
  | "rule"
    | "file"
    | "conversation"
    | "metadata"
    | "other"
    // Observation-path kinds (mt#2033 Path A, 2026-05-21)
    | "hook-injection"
    | "skill-body"
    | "tool-result"
    | "tool-schema"
    | "deferred-tool-catalog"
    | "mcp-instructions"
    | "system-prompt"
    | "user-prompt"
    | "assistant-text"
    | "assistant-thinking";

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
    [key: string]: unknown;
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
  /**
   * Which surface produced this analysis.
   *
   * - "synthesized" — assembled from current workspace state via the synthesis path
   *                   (canonical harness-agnostic baseline of what context should be).
   * - "observed"    — extracted from an actual harness session's transcript via the
   *                   observation path (per-harness reality of what context actually was).
   *
   * Required (not optional) so every analysis result can be classified at the call site
   * without inference. mt#2039 (cross-surface comparison pane) discriminates on this field.
   */
  source: "synthesized" | "observed";

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
    public details?: unknown
  ) {
    super(message);
    this.name = "ContextAnalysisError";
  }
}

// ── Observation-path snapshot (mt#2022) ──────────────────────────────────────
//
// A `SessionContextSnapshot` is the observation-path's primary output: the
// categorized, chronologically-ordered set of context blocks that an actual
// harness session received. Assembled from the canonical transcripts substrate
// (`agent_transcripts.transcript` jsonb + `agent_transcript_attachments` rows)
// by the `assembleSessionContextSnapshot` function in
// `src/domain/transcripts/session-context-snapshot.ts`.
//
// The snapshot's `blocks` are typed against the canonical `ContextElement.type`
// enum (mt#2033) and discriminated as `source: "observed"` — matching the
// `ContextAnalysisResult` discriminator. Downstream consumers (mt#2023 inspector,
// mt#2024 composition pane, mt#2025 origin graph) read from this shape.

/** A single chronological block in a `SessionContextSnapshot`. */
export interface SessionContextSnapshotBlock {
  /** Stable per-session block ID (synthesized from session id + position). */
  id: string;

  /** Unified taxonomy from mt#2033; covers both synthesis and observation kinds. */
  type: ContextElement["type"];

  /** Observation-path blocks are always "observed". */
  source: "observed";

  /** Block content — raw text for turn blocks; structured payload for attachments. */
  content: unknown;

  /** Parent linkage (e.g., `parentUuid` for attachments → preceding turn / attachment). */
  parentId?: string;

  /** ISO-8601 timestamp from the originating JSONL line. */
  timestamp: string;

  /** For turn blocks: 0-indexed position in the transcript array. Unset otherwise. */
  turnIndex?: number;

  /** Original JSONL line type (`user` / `assistant` / `attachment` / `system`). */
  rawJsonlType: string;
}

/** Full categorized context for one harness session, observed (not synthesized). */
export interface SessionContextSnapshot {
  /** The harness-native agent session ID this snapshot was assembled from. */
  agentSessionId: string;

  /** Source harness (`"claude_code"`, etc.). */
  harness: string;

  /** Categorized blocks in chronological order (ascending timestamp). */
  blocks: SessionContextSnapshotBlock[];

  /** When this snapshot was assembled (ISO-8601 UTC). */
  assembledAt: string;
}
