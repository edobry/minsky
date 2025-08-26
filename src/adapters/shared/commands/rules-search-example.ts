/**
 * Example: How rules search could be implemented using the similarity command factory
 * (This is just a demonstration - not replacing the current implementation)
 */

import {
  createSimilaritySearchCommand,
  type EnhancedSearchResult,
} from "./similarity-command-factory";
import { ruleStyleFormatter } from "./rules-search-formatter";
import type { Rule } from "../../../domain/rules/types";

/**
 * Enhanced result type for rules search
 */
interface RuleSearchResult extends EnhancedSearchResult {
  format: string;
}

/**
 * Enhancement function for rules search results
 */
async function enhanceRulesResults(
  results: Array<{ id: string; score?: number }>,
  workspacePath: string
): Promise<RuleSearchResult[]> {
  const enhanced: RuleSearchResult[] = [];

  for (const result of results) {
    try {
      // Get full rule details
      const { ModularRulesService } = await import("../../../domain/rules/rules-service-modular");
      const rulesService = new ModularRulesService(workspacePath);
      const rule = await rulesService.getRule(result.id);

      enhanced.push({
        id: result.id,
        score: result.score,
        name: rule.name || result.id,
        description: rule.description || rule.name || "",
        format: rule.format || "",
      });
    } catch (error) {
      // Rule not found or error loading rule, include minimal info
      enhanced.push({
        id: result.id,
        score: result.score,
        name: result.id,
        description: "",
        format: "",
      });
    }
  }

  return enhanced;
}

/**
 * Create the rules search command using the factory
 */
export const rulesSearchCommand = createSimilaritySearchCommand({
  commandId: "rules.search",
  name: "search",
  description: "Search for rules similar to a natural language query",
  entityName: "rules",

  createService: async () => {
    const { createRuleSimilarityService } = await import(
      "../../../domain/rules/rule-similarity-service"
    );
    return await createRuleSimilarityService();
  },

  searchMethod: async (service, query, limit, threshold) => {
    return await service.searchByText(query, limit, threshold);
  },

  enhanceResults: enhanceRulesResults,
  formatResult: ruleStyleFormatter, // Rules-specific formatter provided by consuming module
});

// This would be registered in the rules commands module:
// sharedCommandRegistry.registerCommand(rulesSearchCommand);
