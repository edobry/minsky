/**
 * Rules list, search, and index-embeddings commands
 */
import { getErrorMessage } from "../../../../errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { type RuleFormat } from "../../../../domain/rules";
import { log } from "../../../../utils/logger";
import { resolveWorkspacePath as defaultResolveWorkspacePath } from "../../../../domain/workspace";
import {
  indexRuleEmbeddings,
  searchRulesEnhanced,
  listRulesFiltered,
} from "../../../../domain/rules/rules-command-operations";
import {
  rulesListCommandParams,
  rulesIndexEmbeddingsParams,
  rulesSearchCommandParams,
  type RulesListParams,
  type RulesIndexEmbeddingsParams,
  type RulesSearchParams,
} from "./rules-parameters";

/**
 * Dependencies for rules list/search commands (injectable for testing)
 */
export interface RulesListSearchCommandsDeps {
  resolveWorkspacePath?: typeof defaultResolveWorkspacePath;
}

export function registerListSearchCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  },
  deps?: RulesListSearchCommandsDeps
): void {
  const resolveWorkspacePath = deps?.resolveWorkspacePath ?? defaultResolveWorkspacePath;
  targetRegistry.registerCommand({
    id: "rules.index-embeddings",
    category: CommandCategory.RULES,
    name: "index-embeddings",
    description: "Generate and store embeddings for rules (rules_embeddings)",
    parameters: rulesIndexEmbeddingsParams,
    execute: async (params: RulesIndexEmbeddingsParams, ctx?: CommandExecutionContext) => {
      try {
        const workspacePath = await resolveWorkspacePath({});
        const json = Boolean(params.json) || ctx?.format === "json";

        const result = await indexRuleEmbeddings({
          workspacePath,
          limit: params.limit,
          force: params.force,
          json,
          debug: params.debug,
        });

        if (json) {
          return result;
        }

        if (result.indexed === 0 && result.skipped === 0 && result.total === 0) {
          log.cli("No rules found to index.");
          return { success: true };
        }

        log.cli(
          `\u2705 Indexed ${result.indexed}/${result.total} rule(s) ` +
            `in ${result.ms}ms (skipped errors: ${result.skipped})`
        );
        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error);
        if (Boolean(params.json) || ctx?.format === "json") {
          return { success: false, error: message };
        }
        log.cliError(`Failed to index rule embeddings: ${message}`);
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.list",
    category: CommandCategory.RULES,
    name: "list",
    description: "List all rules in the workspace",
    parameters: rulesListCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.list command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await listRulesFiltered({
          workspacePath,
          format: params.format as RuleFormat | undefined,
          tag: params.tag,
          since: params.since,
          until: params.until,
          debug: params.debug,
        });
      } catch (error) {
        log.error("Failed to list rules", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (params: RulesSearchParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.search command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        const limit = params.limit ?? 10;
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx?.format === "json";

        if (!quiet && !json && params.query) {
          log.cliWarn(`Searching for rules matching: "${params.query}" ...`);
        }

        if (params.details) {
          try {
            const cfg = await (await import("../../../../domain/configuration")).getConfiguration();
            const provider = cfg.embeddings?.provider || cfg.ai?.defaultProvider || "openai";
            const model = cfg.embeddings?.model || "text-embedding-3-small";
            const effThreshold = params.threshold ?? "(default)";
            log.cliWarn(`Search provider: ${provider}`);
            log.cliWarn(`Model: ${model}`);
            log.cliWarn(`Limit: ${limit}`);
            log.cliWarn(`Threshold: ${String(effThreshold)}`);
          } catch {
            // ignore diagnostics failures
          }
        }

        const enhancedResults = await searchRulesEnhanced({
          workspacePath,
          query: params.query,
          limit,
          threshold: params.threshold,
        });

        return {
          success: true,
          count: enhancedResults.length,
          results: enhancedResults,
          details: params.details,
        };
      } catch (error) {
        log.error("Failed to search rules", {
          error: getErrorMessage(error),
          query: params.query,
        });
        throw error;
      }
    },
  });
}
