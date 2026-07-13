/**
 * AI Command Customizations
 *
 * mt#2727: the `ai.*` shared commands now RETURN structured data from
 * `execute()` instead of printing via `log.cli(...)` inline (the old
 * pattern caused every MCP caller to receive the literal string
 * `"undefined"`, since the MCP adapter serializes the `execute()` return
 * value directly). This file is the CLI-side rendering of those same
 * structured shapes — mirroring the `config.list` / `config.show` pattern
 * in `config-customizations.ts` (formatter over the returned value, not
 * inline printing inside the command).
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "@minsky/shared/logger";
import { exit } from "@minsky/shared/process";
import type { AIModel } from "@minsky/domain/ai/types";
import type { ProviderStatusInfo } from "@minsky/domain/ai/provider-operations";
import type { CachedProviderModel } from "@minsky/domain/ai/model-cache/types";

interface UsageLike {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cost?: number;
}

function formatUsageLines(usage: UsageLike | null | undefined, log_ = log.info): void {
  if (!usage) return;
  log_(
    `Usage: ${usage.totalTokens} tokens ` +
      `(${usage.promptTokens} prompt + ${usage.completionTokens} completion)`
  );
  if (usage.cost) {
    log_(`Cost: $${usage.cost.toFixed(4)}`);
  }
}

/**
 * Get AI command customizations configuration
 */
export function getAiCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.AI,
    options: {
      commandOptions: {
        "ai.validate": {
          outputFormatter: (result: Record<string, unknown>) => {
            if (result.json) {
              log.cli(
                JSON.stringify(
                  {
                    valid: result.valid,
                    errors: result.errors,
                    warnings: result.warnings,
                    providers: result.providers,
                  },
                  null,
                  2
                )
              );
            } else if (result.valid) {
              log.cli("AI configuration is valid!");
            } else {
              log.cliError("AI configuration is invalid:");
              for (const error of (result.errors as Array<{ field: string; message: string }>) ??
                []) {
                log.cliError(`  - ${error.field}: ${error.message}`);
              }
              for (const warning of (result.warnings as Array<{
                field: string;
                message: string;
              }>) ?? []) {
                log.cliWarn(`  - ${warning.field}: ${warning.message}`);
              }
            }

            // Preserve the original CLI exit-code contract: invalid config
            // exits non-zero (useful for scripting). Never call exit() from
            // within execute() itself — that would kill the MCP server
            // process for MCP callers (mt#2727 fix).
            if (!result.valid) {
              exit(1);
            }
          },
        },

        "ai.providers.list": {
          outputFormatter: (result: Record<string, unknown>) => {
            const providers = (result.providers as ProviderStatusInfo[]) ?? [];

            if (result.json || result.format === "json") {
              log.cli(JSON.stringify(providers, null, 2));
              return;
            }

            log.cli("CONFIGURED AI PROVIDERS");
            log.cli("=".repeat(60));

            for (const provider of providers) {
              const status = !provider.hasApiKey
                ? "🚫 Not Configured"
                : provider.lastSuccess === false
                  ? "❌ Error"
                  : provider.isStale
                    ? "⚠️  Cache Stale"
                    : "✅ Ready";

              log.cli(`\n${provider.name.toUpperCase()}`);
              log.cli(`  Status: ${status}`);
              log.cli(`  Models Cached: ${provider.modelCount}`);
              if (provider.lastFetched) {
                log.cli(`  Last Fetched: ` + `${new Date(provider.lastFetched).toLocaleString()}`);
              }
              if (provider.error) {
                log.cli(`  Error: ${provider.error}`);
              }
            }
          },
        },

        "ai.models.available": {
          outputFormatter: (result: Record<string, unknown>) => {
            const models = (result.models as AIModel[]) ?? [];

            if (models.length === 0) {
              const guidance = result.emptyGuidance as
                | { header: string[]; reasons: string[]; configHint?: string }
                | undefined;
              if (guidance) {
                for (const line of guidance.header) log.cliWarn(line);
                for (const reason of guidance.reasons) log.cliWarn(`  - ${reason}`);
                if (guidance.configHint) log.cli(guidance.configHint);
              }
              return;
            }

            if (result.json || result.format === "json") {
              log.cli(JSON.stringify(models, null, 2));
              return;
            }

            log.cli("AVAILABLE AI MODELS");
            log.cli("=".repeat(50));

            for (const model of models) {
              log.cli(`\nModel: ${model.name}`);
              log.cli(`  ID: ${model.id}`);
              log.cli(`  Provider: ${model.provider}`);
              log.cli(`  Context Window: ${model.contextWindow.toLocaleString()} tokens`);
              log.cli(`  Max Output: ${model.maxOutputTokens.toLocaleString()} tokens`);

              if (model.costPer1kTokens) {
                log.cli(
                  `  Cost: $${model.costPer1kTokens.input}/1k input, ` +
                    `$${model.costPer1kTokens.output}/1k output`
                );
              }

              if (model.description) {
                log.cli(`  Description: ${model.description}`);
              }

              if (model.capabilities.length > 0) {
                const caps = model.capabilities.map((c) => c.name).join(", ");
                log.cli(`  Capabilities: ${caps}`);
              }
            }
          },
        },

        "ai.models.list": {
          outputFormatter: (result: Record<string, unknown>) => {
            const modelsToShow = (result.models as Record<string, CachedProviderModel[]>) ?? {};
            const showCache = !!result.showCache;

            if (result.json || result.format === "json") {
              log.cli(JSON.stringify(modelsToShow, null, 2));
            } else if (result.format === "yaml") {
              for (const [providerName, models] of Object.entries(modelsToShow)) {
                log.cli(`${providerName}:`);
                for (const model of models) {
                  log.cli(`  - id: ${model.id}`);
                  log.cli(`    name: ${model.name}`);
                  log.cli(`    contextWindow: ${model.contextWindow}`);
                  log.cli(`    status: ${model.status}`);
                  if (model.costPer1kTokens) {
                    log.cli(
                      `    cost: $${model.costPer1kTokens.input}/` +
                        `$${model.costPer1kTokens.output} per 1k tokens`
                    );
                  }
                }
              }
            } else {
              log.cli("CACHED AI MODELS");
              log.cli("=".repeat(80));

              for (const [providerName, models] of Object.entries(modelsToShow)) {
                if (models.length === 0) {
                  log.cli(`\n${providerName.toUpperCase()}: No cached models`);
                  continue;
                }

                log.cli(`\n${providerName.toUpperCase()} (${models.length} models):`);
                for (const model of models) {
                  log.cli(`  ${model.id}`);
                  log.cli(`    Name: ${model.name}`);
                  log.cli(`    Context: ${model.contextWindow.toLocaleString()} tokens`);
                  log.cli(`    Status: ${model.status}`);
                  if (model.costPer1kTokens) {
                    log.cli(
                      `    Cost: $${model.costPer1kTokens.input}/1k input, ` +
                        `$${model.costPer1kTokens.output}/1k output`
                    );
                  }
                  if (showCache) {
                    log.cli(`    Cached: ${model.fetchedAt.toISOString()}`);
                  }
                  log.cli("");
                }
              }
            }

            if (showCache && result.cacheMetadata) {
              const metadata = result.cacheMetadata as {
                lastUpdated: Date;
                ttl: number;
                nextRefresh: Date;
              };
              log.cli("\nCACHE METADATA:");
              log.cli(`Last Updated: ${metadata.lastUpdated.toISOString()}`);
              log.cli(`TTL: ${Math.round(metadata.ttl / (1000 * 60 * 60))} hours`);
              log.cli(`Next Refresh: ${metadata.nextRefresh.toISOString()}`);
            }
          },
        },

        "ai.models.refresh": {
          outputFormatter: (result: Record<string, unknown>) => {
            // Single-provider refresh mirrors the original CLI: silent on
            // success (refreshSingleProvider throws on failure, which the
            // CLI generator's error handler renders and exits non-zero).
            if (result.provider) return;

            const refreshedCount = Number(result.refreshedCount ?? 0);
            const errors = (result.errors as string[]) ?? [];

            if (refreshedCount > 0) {
              log.cli(`\n✓ Successfully refreshed ${refreshedCount} provider(s)`);
            }
            if (errors.length > 0) {
              log.cliWarn(`Failed to refresh ${errors.length} provider(s): ${errors.join(", ")}`);
              exit(1);
            }
          },
        },

        "ai.cache.clear": {
          outputFormatter: (result: Record<string, unknown>) => {
            const target = String(result.target ?? "all providers");
            if (result.needsConfirm) {
              log.cli(`This will clear cached model data for ${target}.`);
              log.cli("Use --confirm to proceed without this prompt.");
              return;
            }
            log.cli(`✓ Cleared cache for ${target}`);
          },
        },

        "ai.complete": {
          outputFormatter: (result: Record<string, unknown>) => {
            // Streamed completions were already written live to stdout
            // inside execute() (CLI-only path, gated on context.interface
            // === "cli"). Printing `content` again here would double it.
            if (!result.streamed) {
              log.cli(String(result.content ?? ""));
            }
            formatUsageLines(result.usage as UsageLike | null | undefined);
          },
        },

        "ai.fast-apply": {
          outputFormatter: (result: Record<string, unknown>) => {
            const usage = result.usage as UsageLike | undefined;
            if (result.dryRun) {
              log.cli("🔍 Dry run - showing proposed changes:");
              log.cli("\n--- Original ---");
              log.cli(String(result.originalContent ?? ""));
              log.cli("\n--- Edited ---");
              log.cli(String(result.editedContent ?? ""));
              formatUsageLines(usage, log.cli);
            } else {
              log.cli(`✅ Successfully applied edits to ${String(result.filePath ?? "")}`);
              formatUsageLines(usage);
            }
          },
        },
      },
    },
  };
}
