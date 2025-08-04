/**
 * Context suggest-rules command implementation
 *
 * CLI command for AI-powered rule suggestion based on user queries.
 */

import { Command } from "commander";
import { DefaultRuleSuggestionService } from "../../domain/context/rule-suggestion";
import { ModularRulesService } from "../../domain/rules/rules-service-modular";
import { DefaultAICompletionService } from "../../domain/ai/completion-service";
import { DefaultAIConfigurationService } from "../../domain/ai/config-service";
import { getConfiguration } from "../../domain/configuration";
import type { RuleSuggestionRequest, RuleSuggestionResponse } from "../../domain/context/types";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import fs from "fs/promises";

interface SuggestRulesOptions {
  json?: boolean;
  maxSuggestions?: number;
  minRelevance?: number;
  aiProvider?: string;
  aiModel?: string;
  workspacePath?: string;
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
    .option("--max-suggestions <number>", "Maximum number of suggestions to return", "5")
    .option("--min-relevance <number>", "Minimum relevance score (0.0-1.0)", "0.1")
    .option("--ai-provider <provider>", "AI provider to use (openai, anthropic, google)")
    .option("--ai-model <model>", "AI model to use")
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
  const aiConfig = config.ai;

  if (!aiConfig?.providers) {
    log.cliError("No AI providers configured. Please configure at least one provider.");
    exit(1);
  }

  const configService = new DefaultAIConfigurationService({
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  } as any);
  const aiService = new DefaultAICompletionService(configService);
  const rulesService = new ModularRulesService(workspacePath);

  // Create suggestion service with configuration
  const suggestionService = new DefaultRuleSuggestionService(aiService, rulesService, {
    maxSuggestions: parseInt(options.maxSuggestions || "5", 10),
    minRelevanceScore: parseFloat(options.minRelevance || "0.1"),
    aiProvider: options.aiProvider,
    aiModel: options.aiModel,
  });

  // Load workspace rules
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

  // Create suggestion request
  const request: RuleSuggestionRequest = {
    query,
    workspaceRules,
    contextHints,
  };

  // Get suggestions
  const startTime = Date.now();
  const response = await suggestionService.suggestRules(request);
  const totalTime = Date.now() - startTime;

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
      console.log(`   ID: ${suggestion.ruleId}`);
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
