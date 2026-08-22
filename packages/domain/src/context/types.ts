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
   * tool-call / tool-result / tool-schema / deferred-tool-catalog / mcp-instructions /
   * system-prompt / user-prompt / assistant-text / assistant-thinking.
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
    | "tool-call"
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

  /**
   * True when the originating JSONL line carried a top-level
   * `isCompactSummary: true` — Claude Code's marker for the summary it injects
   * at a context-compaction boundary (mt#3260).
   *
   * Verified shape (2026-07-26, local corpus): always
   * `{"type":"user","isCompactSummary":true}` — a top-level boolean on a
   * `user` line, present in 37 of 1003 transcripts. Without this the summary
   * renders as an unmarked giant user turn, which is why "where did my context
   * go" has nowhere to show.
   *
   * Optional and additive: absent on every block that is not a compaction
   * boundary, so no existing consumer changes behavior.
   */
  isCompactSummary?: boolean;

  /**
   * True when the originating JSONL line carried a top-level `isMeta: true` —
   * Claude Code's marker for a line the HARNESS generated rather than the
   * operator (mt#3322).
   *
   * Verified shape (2026-07-29, local corpus): a top-level boolean on a `user`
   * line, carried by the `<local-command-caveat>` block the harness attaches
   * to a slash-command invocation ("Caveat: The messages below were generated
   * by the user while running local commands. DO NOT respond to these
   * messages..." — text addressed to the MODEL, not the operator).
   *
   * This is the one signal that marks harness plumbing STRUCTURALLY rather
   * than by pattern-matching the text; the render surface prefers it over its
   * regex detector where present. Optional and additive: absent on every
   * ordinary turn, so no existing consumer changes behavior.
   */
  isMeta?: boolean;

  /**
   * Who authored this `user` line's text (mt#4354), from the SAME classifier
   * that writes `agent_transcript_turns.user_origin` — `classifyUserLineOrigin`
   * in `../transcripts/user-line-origin.ts` (mt#4289).
   *
   * **Computed here rather than read from the column, deliberately.** The column
   * and this field are two call sites of ONE classifier, not two classifiers —
   * which is the property that matters. Computing has two advantages the column
   * read does not: `turnLineToBlock` also serves the live-tail SSE path
   * (mt#2232), where no `agent_transcript_turns` row exists yet, so a column read
   * would leave every live conversation unlabeled; and it does not depend on the
   * backfill reaching a historical row.
   *
   * **`"human"` is the classifier's FAIL-OPEN default, not positive evidence of
   * operator authorship.** It is the value returned when no structural marker
   * matched, so a consumer must not treat it as a claim. Only a NON-`human`
   * value carries information.
   *
   * Set only when the `user` line actually carries text, mirroring the DB
   * invariant `user_origin IS NOT NULL` ⟺ `user_text IS NOT NULL`. A
   * `tool_result`-only user line contributes no text, and stamping it `human`
   * would put an operator-speech marker on a row that carries none — inverting
   * the question the field exists to answer (`turn-extractor.ts:400-409`).
   *
   * Optional and additive: absent on assistant lines and on text-less user
   * lines, so no existing consumer changes behavior.
   */
  userOrigin?: string;

  /**
   * The assistant message's `model`, when the line carried one (mt#3260).
   *
   * Load-bearing case: Claude Code records a retried turn with the sentinel
   * model `"<synthetic>"` (94 of 1003 local transcripts), which otherwise
   * renders as an ordinary assistant turn.
   */
  model?: string;

  /**
   * Originating JSONL `uuid` — this line's own harness-emitted node id, the
   * other half of the `parentUuid` edge below (mt#3323).
   *
   * Present on turn blocks (the `agent_transcripts.transcript` array stores the
   * JSONL lines verbatim, uuid included). ABSENT on attachment blocks:
   * `agent_transcript_attachments` carries a `parent_uuid` column but no
   * `uuid` column, so an attachment can be a tree CHILD but never a tree
   * PARENT. Consumers walking the tree must treat a missing `uuid` as "cannot
   * have children" rather than assuming every block is addressable.
   *
   * Optional and additive: a consumer that never reads it is unaffected.
   */
  uuid?: string;

  /**
   * True when this block belongs to a superseded (rewound) operator-prompt
   * branch — the operator re-dictated or edited a prompt, and THIS is the
   * version the agent never received (mt#3323).
   *
   * Set by `markAbandonedRewindBranches` (`transcripts/rewind-detection.ts`)
   * at snapshot-assembly time. The block is deliberately still PRESENT in the
   * stream: `SemanticEvent.turnIndex` is index-identical with this block's
   * `turnIndex` (see `event-schema.ts`) and the session film joins on it, so
   * blocks are never removed or re-indexed here. Suppression is the renderer's
   * decision.
   *
   * Fires ONLY on the rewind shape (2+ sibling operator prompts under one
   * `parentUuid`), never on ordinary tree branching — a parallel tool batch
   * forks the tree at every call site with both forks live. Optional and
   * additive: absent on every ordinary block.
   */
  isAbandonedBranch?: boolean;

  /**
   * Originating JSONL `parentUuid` — the harness-emitted external UUID that
   * Claude Code uses to chain lines (attachment → preceding turn/attachment,
   * turn → preceding turn). NOT a synthesized block `id` from this snapshot's
   * namespace; pair it with the `uuid` field above to resolve edges within the
   * snapshot.
   *
   * Renamed from `parentId` per PR #1229 reviewer feedback; the old name
   * implied resolution within the snapshot's id-namespace, which the value
   * does not satisfy.
   */
  parentUuid?: string;

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

  /**
   * Child conversation ids for this session's subagent spawns, keyed by the
   * spawning Agent call's harness `tool_use` id (mt#3692).
   *
   * Joined server-side from `agent_spawns`, whose natural key IS that id — the
   * turn indices on either side of this boundary come from different
   * derivations and do not address each other. Only spawns whose child
   * resolved appear; roughly 30% do today (mt#3702 tracks raising that), and a
   * missing entry renders as a static badge.
   */
  spawnChildrenByToolUseId?: Record<string, string>;

  /**
   * Set when this conversation IS a subagent spawn — the parent that dispatched
   * it (mt#3692). Absent for a conversation with no spawn ancestry, which the
   * UI renders as no backlink rather than an empty placeholder.
   */
  spawnParent?: {
    /** The dispatching conversation's id. */
    agentSessionId: string;
    /** Subagent type this conversation was dispatched as, when recorded. */
    agentKind?: string;
  };

  /**
   * Set ONLY when the request asked for a window (mt#4263).
   *
   * Its absence is what tells a consumer it is holding the whole conversation,
   * so the unwindowed response stays byte-identical to what shipped before —
   * `ContextBlockView`, `ConversationOverviewPanel` and
   * `PublishConversationDialog` all read every block and must keep doing so.
   */
  window?: SessionContextSnapshotWindow;

  /**
   * Every `tool_use` id in the conversation mapped to its tool name, over the
   * FULL transcript — set only on a windowed response (mt#4263).
   *
   * The renderer pairs a tool-result with its call so the result can name what
   * it answers, and it builds that map over ALL turns precisely because a
   * result inside the window routinely answers a call outside it
   * (`conversation-thread-model.ts`, `conversation-turn-assembly.ts`). A
   * windowed client no longer holds the turns to derive it from, so the server
   * sends the map — ids and names only, which is kilobytes against the
   * megabytes the window is there to avoid. An unwindowed response omits it
   * because that client can still derive it, and omitting keeps SC1's
   * byte-for-byte guarantee.
   */
  toolNamesByUseId?: Record<string, string>;

  /** When this snapshot was assembled (ISO-8601 UTC). */
  assembledAt: string;
}

/**
 * Where a windowed snapshot sits within its conversation (mt#4263).
 *
 * `oldestTurnIndex` is an ORIGINAL transcript-array index, not a position
 * within the window — block ids embed that index and `SemanticEvent.turnIndex`
 * is index-identical with it, so re-basing would renumber both. Pass it back as
 * the next request's `before` to page further into the past.
 */
export interface SessionContextSnapshotWindow {
  /** Renderable turn lines in the whole conversation. */
  totalTurns: number;
  /** Renderable turn lines actually returned. */
  returnedTurns: number;
  /**
   * Original transcript-array index of the oldest turn RENDERED in this window,
   * or `null` when the window produced no renderable blocks.
   *
   * Descriptive only — do NOT page with it. It answers "what is the oldest turn
   * on screen", which is a different question from "where does the next request
   * start", and the two diverge exactly when a slice contains only
   * non-renderable entries. Use {@link nextBefore}.
   */
  oldestTurnIndex: number | null;
  /**
   * The exclusive cursor for the next (older) page — pass it back as `before`.
   * `null` when this window already reached index 0.
   *
   * Separate from `oldestTurnIndex` because it is derived from the SLICE the
   * server read, not from what that slice happened to render. A slice whose
   * every entry is non-renderable renders nothing and still consumed those raw
   * indices, so paging must continue below them; keying the cursor on the
   * oldest rendered turn instead made `hasMore: true` reachable with no cursor
   * to act on, which dead-ends paging and — because the client derives its
   * "N earlier turns not loaded" count from the same field — silently renders
   * "Beginning of conversation" over unfetched history (PR #3148 R1).
   */
  nextBefore: number | null;
  /**
   * Whether any turn exists before this window. Equivalent to
   * `nextBefore !== null`; kept as its own field because it is what the render
   * path branches on.
   */
  hasMore: boolean;
}
