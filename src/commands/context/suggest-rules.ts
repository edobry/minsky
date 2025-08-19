/**
 * Context suggest-rules command implementation
 *
 * CLI command for AI-powered rule suggestion based on user queries.
 */

import { Command } from "commander";
import { DefaultRuleSuggestionService } from "../../domain/context/rule-suggestion";
import { ModularRulesService } from "../../domain/rules/rules-service-modular";
import { getConfiguration } from "../../domain/configuration";
import type { RuleSuggestionRequest, RuleSuggestionResponse } from "../../domain/context/types";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import fs from "fs/promises";
import { getEmbeddingDimension } from "../../domain/ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../../domain/ai/embedding-service-factory";
import { PostgresVectorStorage } from "../../domain/storage/vector/postgres-vector-storage";
import { RuleSimilarityService } from "../../domain/rules/rule-similarity-service";

interface SuggestRulesOptions {
  json?: boolean;
  maxSuggestions?: number;
  minRelevance?: number;
  workspacePath?: string;
  limit?: number;
  threshold?: number;
  noEmbeddings?: boolean;
}

/**
 * Create the suggest-rules command
 */
export function createSuggestRulesCommand(): Command {
  const command = new Command("suggest-rules");

  command
    .description("Get AI-powered rule suggestions for your current task")
    .argument("<query>", "Natural language description of what you want to accomplish")
    .option("--json", "Output results in JSON format", false)
    .option("--limit <number>", "Maximum number of suggestions to return", "5")
    .option("--threshold <number>", "Maximum vector distance threshold (optional)")
    .option("--no-embeddings", "Disable embeddings search and use keyword fallback only", false)
    .option("--workspace-path <path>", "Workspace path for context")
    .addHelpText(
      "after",
      `
Examples:
  minsky context suggest-rules "I need to fix a bug in authentication"
  minsky context suggest-rules "refactor code organization" --json
  minsky context suggest-rules "add tests for new feature" --max-suggestions 3
  minsky context suggest-rules "implement error handling" --ai-provider anthropic

The command analyzes your query and suggests relevant rules from your workspace
based on rule descriptions, tags, and your specific context.
`
    )
    .action(async (query: string, options: SuggestRulesOptions) => {
      try {
        await executeSuggestRules(query, options);
      } catch (error) {
        log.cliError(`Failed to suggest rules: ${error.message}`);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Execute the suggest-rules command
 */
async function executeSuggestRules(query: string, options: SuggestRulesOptions): Promise<void> {
  // Determine workspace path
  const workspacePath = options.workspacePath || process.cwd();

  // Initialize services
  const config = getConfiguration();
  const rulesService = new ModularRulesService(workspacePath);

  // Choose embeddings-first path unless disabled
  const useEmbeddings = options.noEmbeddings !== true;

  // Load workspace rules (for fallback/metadata enrichment)
  const workspaceRules = await rulesService.listRules();

  if (workspaceRules.length === 0) {
    log.cliWarn("No rules found in workspace. Consider adding some rules first.");
    if (options.json) {
      console.log(JSON.stringify({ suggestions: [], message: "No rules found" }, null, 2));
    }
    return;
  }

  // Gather context hints
  const contextHints = await gatherContextHints(workspacePath);

  const startTime = Date.now();
  let totalTime = 0;
  if (useEmbeddings) {
    // Build embedding service and vector storage for rules
    const model = (config as any).embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);
    const embedding = await createEmbeddingServiceFromConfig();
    const storage = await PostgresVectorStorage.fromSessionDbConfig(dimension, {
      tableName: "rules_embeddings",
      idColumn: "rule_id",
      embeddingColumn: "embedding",
      dimensionColumn: "dimension",
      lastIndexedAtColumn: "last_indexed_at",
    });
    const sim = new RuleSimilarityService(embedding, storage, {});
    const limit = parseInt(String(options.limit || 5), 10);
    const threshold = options.threshold !== undefined ? Number(options.threshold) : undefined;
    const results = await sim.searchByText(query, limit, threshold);

    // Hydrate results to suggestions compatible with output
    const byId = new Map(workspaceRules.map((r) => [r.id, r] as const));
    const suggestions = results
      .map((r, idx) => ({
        ruleId: r.id,
        relevanceScore: Math.max(0, 1 - r.score),
        reasoning: "Embedding similarity match",
        confidenceLevel: r.score < 0.3 ? "high" : r.score < 0.6 ? "medium" : "low",
        ruleName: byId.get(r.id)?.name,
      }))
      .slice(0, limit);

    const response: RuleSuggestionResponse = {
      suggestions,
      queryAnalysis: {
        intent: `Embeddings search for: ${query}`,
        keywords: query.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
        suggestedCategories: [],
      },
      totalRulesAnalyzed: workspaceRules.length,
      processingTimeMs: Math.max(1, Date.now() - startTime),
    };
    totalTime = response.processingTimeMs;
    if (options.json) {
      outputJsonResults(response);
    } else {
      outputHumanReadableResults(response, query, totalTime);
    }
    return;
  } else {
    // Fallback to existing AI-based suggestion service
    const { DefaultAICompletionService } = await import("../../domain/ai/completion-service");
    const mockConfigService = { loadConfiguration: () => Promise.resolve({ resolved: config }) } as any;
    const aiService = new DefaultAICompletionService(mockConfigService);
    const suggestionService = new DefaultRuleSuggestionService(aiService, rulesService, {
      maxSuggestions: parseInt(String(options.limit || 5), 10),
      minRelevanceScore: 0.1,
    });
    const request: RuleSuggestionRequest = { query, workspaceRules, contextHints };
    const response = await suggestionService.suggestRules(request);
    totalTime = Math.max(1, Date.now() - startTime);
    if (options.json) {
      outputJsonResults(response);
    } else {
      outputHumanReadableResults(response, query, totalTime);
    }
  }

  // Output results
  if (options.json) {
    outputJsonResults(response);
  } else {
    outputHumanReadableResults(response, query, totalTime);
  }
}

/**
 * Gather context hints about the current workspace
 */
async function gatherContextHints(
  workspacePath: string
): Promise<RuleSuggestionRequest["contextHints"]> {
  // Basic context gathering - can be enhanced later
  const hints: RuleSuggestionRequest["contextHints"] = {
    workspacePath,
  };

  // Try to detect project type from package.json
  try {
    const packageJsonPath = `${workspacePath}/package.json`;
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

    if (packageJson.dependencies || packageJson.devDependencies) {
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      if (deps.typescript || deps["@types/node"]) {
        hints.projectType = "typescript";
      } else if (deps.react || deps["@types/react"]) {
        hints.projectType = "react";
      } else if (deps.express || deps.fastify) {
        hints.projectType = "node-backend";
      } else {
        hints.projectType = "javascript";
      }
    }
  } catch {
    // Ignore errors - context hints are optional
  }

  return hints;
}

/**
 * Output results in JSON format
 */
function outputJsonResults(response: RuleSuggestionResponse): void {
  console.log(JSON.stringify(response, null, 2));
}

/**
 * Output results in human-readable format
 */
function outputHumanReadableResults(
  response: RuleSuggestionResponse,
  query: string,
  totalTime: number
): void {
  console.log(`\n🔍 Rule suggestions for: "${query}"\n`);

  // Query analysis
  console.log(`📝 Analysis:`);
  console.log(`   Intent: ${response.queryAnalysis.intent}`);
  console.log(`   Keywords: ${response.queryAnalysis.keywords.join(", ")}`);
  if (response.queryAnalysis.suggestedCategories.length > 0) {
    console.log(`   Categories: ${response.queryAnalysis.suggestedCategories.join(", ")}`);
  }
  console.log();

  // Suggestions
  if (response.suggestions.length === 0) {
    console.log("❌ No relevant rules found for your query.");
    console.log(
      "   Try rephrasing your query or check if you have applicable rules in your workspace."
    );
  } else {
    console.log(
      `✨ Found ${response.suggestions.length} relevant rule${response.suggestions.length > 1 ? "s" : ""}:\n`
    );

    response.suggestions.forEach((suggestion, index) => {
      const confidenceEmoji = getConfidenceEmoji(suggestion.confidenceLevel);
      const scoreFormatted = (suggestion.relevanceScore * 100).toFixed(0);

      console.log(`${index + 1}. ${suggestion.ruleName || suggestion.ruleId} ${confidenceEmoji}`);
      console.log(`   Relevance: ${scoreFormatted}% (${suggestion.confidenceLevel} confidence)`);
      console.log(`   Reasoning: ${suggestion.reasoning}`);
      console.log();
    });
  }

  // Performance info
  console.log(`📊 Performance:`);
  console.log(`   Analyzed ${response.totalRulesAnalyzed} rules in ${response.processingTimeMs}ms`);
  console.log(`   Total time: ${totalTime}ms`);
  console.log();

  // Usage hints
  if (response.suggestions.length > 0) {
    console.log(`💡 To use a rule: Add it to your Cursor Rules or check its content with:`);
    console.log(`   minsky rules get ${response.suggestions[0].ruleId}`);
  }
}

/**
 * Get emoji for confidence level
 */
function getConfidenceEmoji(confidence: string): string {
  switch (confidence) {
    case "high":
      return "🎯";
    case "medium":
      return "📌";
    case "low":
      return "💭";
    default:
      return "📌";
  }
}
