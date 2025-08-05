/**
 * Types for rule suggestion functionality
 */

import type { Rule } from "../rules/types";

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
