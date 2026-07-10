/**
 * Config Validate and Doctor Commands
 *
 * Defines the config.validate and config.doctor command registrations.
 */

import { z } from "zod";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { CommandCategory, defineCommand } from "../../command-registry";
import { CommonParameters, ConfigParameters, composeParams } from "../../common-parameters";

/**
 * A single config.doctor diagnostic entry.
 */
export interface DoctorDiagnostic {
  check: string;
  status: "pass" | "warning" | "error";
  message: string;
  suggestion?: string;
}

/**
 * Reviewer-retrigger reachability check (mt#2660).
 *
 * `reviewer.retrigger` (src/adapters/shared/commands/reviewer-retrigger.ts)
 * authenticates against the reviewer service's `/retrigger` endpoint using
 * `mcp.auth.token` (← `MINSKY_MCP_AUTH_TOKEN`), NOT the webhook HMAC secret
 * (mt#2346). `reviewer.url` always resolves to a usable target — when unset
 * it falls back to the Minsky-hosted default (DEFAULT_REVIEWER_URL) — so the
 * reviewer service is effectively always "configured" for retrigger purposes.
 * The token is the one precondition that can silently be missing.
 *
 * Without this token, `resolveReviewerEndpoint` throws at CALL time — which
 * historically was only discovered mid-incident, exactly when an operator
 * needed the tool most (mt#2660 / PR #1812: `reviewer.retrigger` errored
 * with "requires MINSKY_MCP_AUTH_TOKEN / mcp.auth.token" during the recovery
 * attempt, forcing a manual retrigger commit instead). Surfacing the gap
 * here, at setup-diagnostic time, lets an operator catch it before it's
 * needed.
 *
 * Exported as a pure function (config in, diagnostic out) so it's unit
 * testable without mocking the config-provider module loader.
 */
export function checkReviewerRetriggerReachability(
  mcpAuthToken: string | undefined
): DoctorDiagnostic {
  if (!mcpAuthToken) {
    return {
      check: "Reviewer Retrigger Reachability",
      status: "warning",
      message:
        "`mcp.auth.token` is not set — `reviewer.retrigger` will fail with " +
        '"requires the Minsky MCP auth token" when invoked. This is the ' +
        "on-demand recovery path for a review the reviewer-service sweeper " +
        "hasn't yet caught (see mt#2660).",
      suggestion:
        "Set mcp.auth.token in your Minsky config, or export MINSKY_MCP_AUTH_TOKEN, " +
        "to make reviewer.retrigger usable.",
    };
  }
  return {
    check: "Reviewer Retrigger Reachability",
    status: "pass",
    message: "`mcp.auth.token` is set — `reviewer.retrigger` is reachable.",
  };
}

/**
 * Shared parameters for config commands (eliminates duplication)
 */
const configCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
    workspace: CommonParameters.workspace,
    json: CommonParameters.json,
  },
  {
    sources: ConfigParameters.sources,
  }
);

/**
 * Config validate command
 */
export const configValidateRegistration = defineCommand({
  id: "config.validate",
  category: CommandCategory.CONFIG,
  name: "validate",
  description: "Validate configuration against schemas",
  requiresSetup: false,
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed validation results",
      required: false as const,
      defaultValue: false,
    },
  }),
  execute: async (params, _ctx) => {
    const { getConfigurationProvider, validateConfiguration } = await import(
      "@minsky/domain/configuration/index"
    );
    const provider = getConfigurationProvider();
    const validationResult = validateConfiguration();
    const hasErrors = validationResult.errors.some(
      (e: { severity?: string }) => e.severity === "error"
    );
    const hasWarnings = validationResult.errors.some(
      (e: { severity?: string }) => e.severity === "warning"
    );

    return {
      success: validationResult.valid && !hasErrors,
      json: params.json || false,
      valid: validationResult.valid,
      hasErrors,
      hasWarnings,
      errors: validationResult.errors,
      totalIssues: validationResult.errors.length,
      sources: provider.getMetadata?.().sources,
      verbose: params.verbose || false,
    };
  },
});

/**
 * Config doctor command
 */
export const configDoctorRegistration = defineCommand({
  id: "config.doctor",
  category: CommandCategory.CONFIG,
  name: "doctor",
  description: "Diagnose common configuration problems",
  requiresSetup: false,
  parameters: composeParams(configCommandParams, {
    verbose: {
      schema: z.boolean(),
      description: "Show detailed diagnostic results",
      required: false as const,
      defaultValue: false,
    },
    fix: {
      schema: z.boolean(),
      description:
        "Apply available auto-fixes for failed checks (e.g. provision mcp.auth.token from railway-secrets.json) instead of only reporting them (mt#2679)",
      required: false as const,
      defaultValue: false,
    },
  }),
  execute: async (params, ctx) => {
    // Perform lightweight diagnostics without external calls
    const diagnostics: Array<{ check: string; status: string; message: string }> = [];
    const { getConfigurationProvider, validateConfiguration } = await import(
      "@minsky/domain/configuration/index"
    );
    const { getUserConfigDir } = await import("@minsky/domain/configuration/sources/user");
    const { existsSync, writeFileSync, unlinkSync } = await import("fs");
    const { join } = await import("path");

    try {
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      if (config) {
        diagnostics.push({
          check: "Configuration Loading",
          status: "pass",
          message: "Configuration loaded successfully",
        });
      } else {
        diagnostics.push({
          check: "Configuration Loading",
          status: "error",
          message: "Configuration could not be loaded",
        });
      }
    } catch (e) {
      diagnostics.push({
        check: "Configuration Loading",
        status: "error",
        message: `Configuration loading failed: ${getErrorMessage(e)}`,
      });
    }

    try {
      const validationResult = validateConfiguration();
      const hasErrors = validationResult.errors.some(
        (e: { severity?: string }) => e.severity === "error"
      );
      diagnostics.push({
        check: "Configuration Validation",
        status: hasErrors ? "error" : validationResult.errors.length > 0 ? "warning" : "pass",
        message:
          validationResult.errors.length === 0
            ? "Configuration passes validation"
            : `Found ${validationResult.errors.length} validation issues`,
      });
    } catch (e) {
      diagnostics.push({
        check: "Configuration Validation",
        status: "error",
        message: `Validation check failed: ${getErrorMessage(e)}`,
      });
    }

    // Reviewer retrigger reachability (mt#2660) + turnkey auto-fix (mt#2679).
    try {
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const reachability = checkReviewerRetriggerReachability(config.mcp?.auth?.token);

      // --fix: provision mcp.auth.token from the local railway-secrets store
      // instead of telling the operator to edit config by hand (the deferral
      // that kept mt#2679's four incidents recurring). The fix never prints
      // the secret value. On a SUCCESSFUL fix the pass-shaped fix diagnostic
      // REPLACES the initial warning (one coherent signal per check — PR
      // #1855 R1); on a failed/unavailable fix both surface so the operator
      // sees the gap AND why the auto-fix couldn't close it.
      if (params.fix && reachability.status === "warning") {
        const { fixMcpAuthTokenFromSecretsFile } = await import("./doctor-fixes");
        const { createConfigWriter } = await import("@minsky/domain/configuration/config-writer");
        const { readFileSync } = await import("fs");
        const fixOutcome = await fixMcpAuthTokenFromSecretsFile({
          configDir: getUserConfigDir(),
          readFile: (p: string): string => readFileSync(p, { encoding: "utf-8" }).toString(),
          writer: createConfigWriter({ createBackup: true, format: "yaml", validate: true }),
        });
        if (fixOutcome.status === "pass") {
          diagnostics.push(fixOutcome);
        } else {
          diagnostics.push(reachability, fixOutcome);
        }
      } else {
        diagnostics.push(reachability);
      }
    } catch (e) {
      diagnostics.push({
        check: "Reviewer Retrigger Reachability",
        status: "error",
        message: `Reviewer retrigger reachability check failed: ${getErrorMessage(e)}`,
      });
    }

    try {
      const configDir = getUserConfigDir();
      if (!existsSync(configDir)) {
        diagnostics.push({
          check: "Configuration Directory",
          status: "warning",
          message: `Configuration directory does not exist: ${configDir}`,
        });
      } else {
        diagnostics.push({
          check: "Configuration Directory",
          status: "pass",
          message: `Configuration directory exists: ${configDir}`,
        });

        // Basic write test
        const testFile = join(configDir, ".minsky-test");
        try {
          writeFileSync(testFile, "test");
          unlinkSync(testFile);
          diagnostics.push({
            check: "File Permissions",
            status: "pass",
            message: "Configuration directory is writable",
          });
        } catch {
          diagnostics.push({
            check: "File Permissions",
            status: "error",
            message: "Configuration directory is not writable",
          });
        }
      }
    } catch (e) {
      diagnostics.push({
        check: "Filesystem Check",
        status: "error",
        message: `Filesystem check failed: ${getErrorMessage(e)}`,
      });
    }

    // Embedding provider health probe
    try {
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const embProvider = config.embeddings?.provider || config.ai?.defaultProvider || "openai";
      const embModel = config.embeddings?.model || "text-embedding-3-small";
      const providerCfg = config.ai?.providers?.[embProvider];
      const hasKey = Boolean(providerCfg?.apiKey || providerCfg?.api_key);

      if (!hasKey) {
        diagnostics.push({
          check: "Embedding Provider",
          status: "warning",
          message: `Embedding provider "${embProvider}" has no API key configured`,
        });
      } else {
        const { createEmbeddingServiceFromConfig } = await import(
          "@minsky/domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();
        await embeddingService.generateEmbedding("test");
        diagnostics.push({
          check: "Embedding Provider",
          status: "pass",
          message: `Embedding provider "${embProvider}" (${embModel}) is working`,
        });
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      const isQuota = /quota|429|insufficient/i.test(msg);
      const isAuth = /401|unauthorized|api.key/i.test(msg);
      diagnostics.push({
        check: "Embedding Provider",
        status: "error",
        message: `Embedding provider check failed: ${msg}`,
        ...(isQuota && {
          suggestion: "Check your OpenAI billing at https://platform.openai.com/account/billing",
        }),
        ...(isAuth && {
          suggestion: "API key may be invalid or expired — https://platform.openai.com/api-keys",
        }),
      });
    }

    // Embedding index coverage
    try {
      const provider = ctx.container?.has("persistence")
        ? (ctx.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").PersistenceProvider)
        : null;
      if (provider) {
        if (provider.capabilities.sql) {
          const rawSql = await provider.getRawSqlConnection?.();
          if (rawSql) {
            const sql = rawSql as import("postgres").Sql;
            const [taskCount] = await sql.unsafe("SELECT count(*) as count FROM tasks");
            const [embCount] = await sql.unsafe("SELECT count(*) as count FROM tasks_embeddings");
            const [lastIdx] = await sql.unsafe(
              "SELECT max(indexed_at) as last_indexed FROM tasks_embeddings"
            );
            const total = Number(taskCount?.count ?? 0);
            const indexed = Number(embCount?.count ?? 0);
            const lastIndexed = lastIdx?.last_indexed
              ? new Date(lastIdx.last_indexed as string).toISOString()
              : "never";
            const pct = total > 0 ? Math.round((indexed / total) * 100) : 0;
            diagnostics.push({
              check: "Embedding Index Coverage",
              status: pct >= 90 ? "pass" : pct >= 50 ? "warning" : "error",
              message: `${indexed}/${total} tasks indexed (${pct}%), last indexed: ${lastIndexed}`,
              ...(pct < 90 && {
                suggestion: "Run 'minsky tasks index-embeddings' to index missing tasks",
              }),
            });
          }
        }
      }
    } catch {
      // Index coverage is best-effort — skip if DB not available
    }

    const errors = diagnostics.filter((d) => d.status === "error");
    const warnings = diagnostics.filter((d) => d.status === "warning");

    return {
      success: errors.length === 0,
      json: params.json || false,
      summary: {
        total: diagnostics.length,
        passed: diagnostics.filter((d) => d.status === "pass").length,
        warnings: warnings.length,
        errors: errors.length,
      },
      diagnostics,
      healthy: errors.length === 0,
      verbose: params.verbose || false,
    };
  },
});
