import type { Rule } from "./types";
import { classifyRuleType, RuleType } from "./rule-classifier";
import { matchesGlobPatterns } from "./glob-matcher";

/**
 * Options for enhanced rule suggestion
 */
export interface RuleSuggestOptions {
  /** User query for semantic similarity matching */
  query?: string;
  /** Files currently in context for glob matching */
  filesInContext?: string[];
  /** Whether to include manual rules (default: false) */
  includeManual?: boolean;
  /** Maximum number of agent-requested rules to return */
  limit?: number;
  /** Minimum similarity threshold for agent-requested rules */
  threshold?: number;
}

/**
 * Similarity service interface (for dependency injection)
 */
export interface ISimilarityService {
  searchByText(query: string, limit: number, threshold?: number): Promise<Array<{ id: string; score: number }>>;
}

/**
 * Enhanced rule suggestion with type-aware filtering
 * 
 * Implements Cursor-like rule type system:
 * 1. Always Apply - Always included
 * 2. Auto Attached - Included when files match globs
 * 3. Agent Requested - Included based on query similarity
 * 4. Manual - Only included when explicitly requested
 * 
 * @param options - Suggestion options
 * @param allRules - All available rules (defaults to fetching from service)
 * @param similarityService - Optional similarity service for testing
 * @returns Array of suggested rules
 */
export async function suggestRules(
  options: RuleSuggestOptions,
  allRules?: Rule[],
  similarityService?: ISimilarityService
): Promise<Rule[]> {
  // Default options
  const {
    query,
    filesInContext = [],
    includeManual = false,
    limit = 10,
    threshold = 0.1
  } = options;

  // Get all rules if not provided
  if (!allRules) {
    // In production, this would fetch from RulesService
    // For now, return empty array
    return [];
  }

  const suggestions: Rule[] = [];
  const addedRuleIds = new Set<string>();

  // Helper to add rule without duplicates
  const addRule = (rule: Rule) => {
    if (!addedRuleIds.has(rule.id)) {
      suggestions.push(rule);
      addedRuleIds.add(rule.id);
    }
  };

  // 1. Always Apply rules - always include
  const alwaysApplyRules = allRules.filter(
    rule => classifyRuleType(rule) === RuleType.ALWAYS_APPLY
  );
  alwaysApplyRules.forEach(addRule);

  // 2. Auto Attached rules - include if files match globs
  if (filesInContext.length > 0) {
    const autoAttachedRules = allRules.filter(
      rule => classifyRuleType(rule) === RuleType.AUTO_ATTACHED
    );
    
    for (const rule of autoAttachedRules) {
      if (rule.globs && matchesGlobPatterns(rule.globs, filesInContext)) {
        addRule(rule);
      }
    }
  }

  // 3. Agent Requested rules - include based on query similarity
  if (query && similarityService) {
    try {
      // Get only agent-requested rules
      const agentRequestedRules = allRules.filter(
        rule => classifyRuleType(rule) === RuleType.AGENT_REQUESTED
      );
      const agentRequestedIds = new Set(agentRequestedRules.map(r => r.id));

      // Search for similar rules
      const searchResults = await similarityService.searchByText(query, limit, threshold);
      
      // Filter to only agent-requested rules and add them
      for (const result of searchResults) {
        if (agentRequestedIds.has(result.id)) {
          const rule = allRules.find(r => r.id === result.id);
          if (rule) {
            addRule(rule);
          }
        }
      }
    } catch (error) {
      // If similarity service fails, continue without agent-requested rules
      console.warn("Failed to search for agent-requested rules:", error);
    }
  }

  // 4. Manual rules - only include if explicitly requested
  if (includeManual) {
    const manualRules = allRules.filter(
      rule => classifyRuleType(rule) === RuleType.MANUAL
    );
    manualRules.forEach(addRule);
  }

  return suggestions;
}

/**
 * Group rules by their type for organized display
 */
export function groupRulesByType(rules: Rule[]): Record<string, Rule[]> {
  const grouped: Record<string, Rule[]> = {
    always: [],
    autoAttached: [],
    agentRequested: [],
    manual: []
  };

  for (const rule of rules) {
    const type = classifyRuleType(rule);
    switch (type) {
      case RuleType.ALWAYS_APPLY:
        grouped.always.push(rule);
        break;
      case RuleType.AUTO_ATTACHED:
        grouped.autoAttached.push(rule);
        break;
      case RuleType.AGENT_REQUESTED:
        grouped.agentRequested.push(rule);
        break;
      case RuleType.MANUAL:
        grouped.manual.push(rule);
        break;
    }
  }

  return grouped;
}
