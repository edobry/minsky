/**
 * Tools Similarity Commands
 *
 * Implements search and similar commands for tools using the same patterns
 * as tasks and rules similarity commands.
 */
import { z } from "zod";
import type { CommandExecutionContext, CommandParameterMap } from "../../command-registry";
import { sharedCommandRegistry } from "../../command-registry";
import { createLogger } from "../../../../utils/logger";
import { CommonParameters } from "../../common-parameters";

const log = createLogger("tools-similarity-commands");

// === Parameter Definitions ===

const toolsSimilarParams: CommandParameterMap = {
  toolId: {
    schema: z.string(),
    help: "Tool ID to find similar tools for",
    required: true,
  },
  limit: {
    schema: z.number().int().positive().default(10),
    help: "Maximum number of results to return",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    help: "Optional similarity threshold (higher is more similar)",
    required: false,
  },
  details: {
    schema: z.boolean().default(false),
    help: "Show detailed output including scores and diagnostics",
    required: false,
  },
  json: CommonParameters.json,
};

const toolsSearchParams: CommandParameterMap = {
  query: {
    schema: z.string(),
    help: "Natural language query to search for tools",
    required: true,
  },
  limit: {
    schema: z.number().int().positive().default(10),
    help: "Maximum number of results to return",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    help: "Optional similarity threshold (higher is more similar)",
    required: false,
  },
  category: {
    schema: z.string().optional(),
    help: "Filter by tool category (e.g., TASKS, GIT, DEBUG)",
    required: false,
  },
  details: {
    schema: z.boolean().default(false),
    help: "Show detailed output including scores and diagnostics",
    required: false,
  },
  quiet: {
    schema: z.boolean().default(false),
    help: "Suppress progress messages",
    required: false,
  },
  json: CommonParameters.json,
};

// === Type Definitions ===

interface ToolsSimilarParams {
  toolId: string;
  limit?: number;
  threshold?: number;
  details?: boolean;
  json?: boolean;
}

interface ToolsSearchParams {
  query: string;
  limit?: number;
  threshold?: number;
  category?: string;
  details?: boolean;
  quiet?: boolean;
  json?: boolean;
}

// === Enhanced Result Interface ===

interface EnhancedToolResult {
  id: string;
  score?: number;
  name?: string;
  description?: string;
  category?: string;
}

// === Command Classes ===

export class ToolsSimilarCommand {
  readonly id = "tools.similar";
  readonly name = "similar";
  readonly description = "Find tools similar to the given tool using embeddings";
  readonly parameters = toolsSimilarParams;

  /**
   * Enhance search results with tool details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false
  ): Promise<EnhancedToolResult[]> {
    const enhanced = [];

    for (const result of searchResults) {
      try {
        const tool = sharedCommandRegistry.getCommand(result.id);

        if (tool) {
          enhanced.push({
            id: result.id,
            score: result.score,
            name: tool.name,
            description: includeDetails ? tool.description : undefined,
            category: tool.category,
          });
        } else {
          // Tool not found, include minimal info
          enhanced.push({
            id: result.id,
            score: result.score,
            name: "(Tool not found)",
            category: "UNKNOWN",
          });
        }
      } catch (error) {
        // Error loading tool, include minimal info
        enhanced.push({
          id: result.id,
          score: result.score,
          name: "(Error loading tool)",
          category: "ERROR",
        });
      }
    }

    return enhanced;
  }

  async execute(params: ToolsSimilarParams, ctx?: CommandExecutionContext) {
    const toolId = params.toolId;
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    // Create tool similarity service
    const { createToolSimilarityService } = await import(
      "../../../../domain/tools/similarity/tool-similarity-service"
    );
    const service = await createToolSimilarityService();

    const searchResults = await service.similarToTool(toolId, limit, threshold);

    // Enhance results with tool details for better usability
    const enhancedResults = await this.enhanceSearchResults(searchResults, params.details);

    const result = {
      success: true,
      count: enhancedResults.length,
      results: enhancedResults,
      details: params.details, // Pass through details flag for CLI formatter
    };

    if (params.json || ctx?.format === "json") {
      return result;
    }

    // CLI-friendly output
    if (enhancedResults.length === 0) {
      return `No similar tools found for: ${toolId}`;
    }

    let output = `Found ${enhancedResults.length} similar tools for: ${toolId}\n\n`;
    
    enhancedResults.forEach((tool, index) => {
      const scoreDisplay = tool.score ? ` (score: ${tool.score.toFixed(3)})` : "";
      output += `${index + 1}. ${tool.name} [${tool.id}]${scoreDisplay}\n`;
      if (tool.category) {
        output += `   Category: ${tool.category}\n`;
      }
      if (params.details && tool.description) {
        output += `   Description: ${tool.description}\n`;
      }
      output += "\n";
    });

    return output.trim();
  }
}

export class ToolsSearchCommand {
  readonly id = "tools.search";
  readonly name = "search";
  readonly description = "Search for tools using natural language queries";
  readonly parameters = toolsSearchParams;

  /**
   * Enhance search results with tool details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false
  ): Promise<EnhancedToolResult[]> {
    const enhanced = [];

    for (const result of searchResults) {
      try {
        const tool = sharedCommandRegistry.getCommand(result.id);

        if (tool) {
          enhanced.push({
            id: result.id,
            score: result.score,
            name: tool.name,
            description: includeDetails ? tool.description : undefined,
            category: tool.category,
          });
        } else {
          // Tool not found, include minimal info
          enhanced.push({
            id: result.id,
            score: result.score,
            name: "(Tool not found)",
            category: "UNKNOWN",
          });
        }
      } catch (error) {
        // Error loading tool, include minimal info
        enhanced.push({
          id: result.id,
          score: result.score,
          name: "(Error loading tool)",
          category: "ERROR",
        });
      }
    }

    return enhanced;
  }

  async execute(params: ToolsSearchParams, ctx?: CommandExecutionContext) {
    const query = params.query;
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    // Create tool similarity service
    const { createToolSimilarityService } = await import(
      "../../../../domain/tools/similarity/tool-similarity-service"
    );
    const service = await createToolSimilarityService();

    // Immediate progress hint to stderr unless JSON/quiet
    if (!params.quiet && !params.json && ctx?.format !== "json") {
      log.cliWarn(`Searching for tools matching: "${query}" ...`);
    }

    // Optional human-friendly diagnostics (no global debug needed)
    if (params.details) {
      try {
        const cfg = await (await import("../../../../domain/configuration")).getConfiguration();
        const provider =
          (cfg as any).embeddings?.provider || (cfg as any).ai?.defaultProvider || "openai";
        const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
        const effThreshold = threshold ?? "(default)";
        
        // Print to CLI in human-friendly lines
        // Write diagnostics to stderr so --json stays clean on stdout
        log.cliWarn(`Search provider: ${provider}`);
        log.cliWarn(`Model: ${model}`);
        log.cliWarn(`Limit: ${limit}`);
        log.cliWarn(`Threshold: ${String(effThreshold)}`);
      } catch {
        // ignore details preflight errors
      }
    }

    const searchResults = await service.searchByText(query, limit, threshold);

    // Apply category filter if provided (client-side for now)
    let filteredResults = searchResults;
    if (params.category) {
      filteredResults = searchResults.filter((result) => {
        const tool = sharedCommandRegistry.getCommand(result.id);
        return tool && tool.category === params.category;
      });
    }

    // Enhance results with tool details for better usability
    const enhancedResults = await this.enhanceSearchResults(filteredResults, params.details);

    const result = {
      success: true,
      count: enhancedResults.length,
      results: enhancedResults,
      details: params.details, // Pass through details flag for CLI formatter
    };

    if (params.json || ctx?.format === "json") {
      return result;
    }

    // CLI-friendly output
    if (enhancedResults.length === 0) {
      return `No tools found matching: "${query}"`;
    }

    let output = `Found ${enhancedResults.length} tools matching: "${query}"\n\n`;
    
    enhancedResults.forEach((tool, index) => {
      const scoreDisplay = tool.score ? ` (score: ${tool.score.toFixed(3)})` : "";
      output += `${index + 1}. ${tool.name} [${tool.id}]${scoreDisplay}\n`;
      if (tool.category) {
        output += `   Category: ${tool.category}\n`;
      }
      if (params.details && tool.description) {
        output += `   Description: ${tool.description}\n`;
      }
      output += "\n";
    });

    return output.trim();
  }
}

// === Factory Functions ===

export function createToolsSimilarCommand(): ToolsSimilarCommand {
  return new ToolsSimilarCommand();
}

export function createToolsSearchCommand(): ToolsSearchCommand {
  return new ToolsSearchCommand();
}
