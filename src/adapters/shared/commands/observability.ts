/**
 * Shared Observability Commands
 *
 * Commands for managing observability provider integration (currently Braintrust).
 * First command: `observability smoke-test` — validates that the configured
 * Braintrust credentials can authenticate and emit a single event to the
 * project dashboard.
 *
 * Pattern: mirrors `src/adapters/shared/commands/persistence.ts` (direct
 * `sharedCommandRegistry.registerCommand`).
 *
 * @see mt#1795 — originating task (minimal SDK wiring)
 * @see mt#1778 — parent observability strategy
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";

/**
 * Read a config value with a fallback. Returns the fallback when the path
 * is not present in the loaded configuration. The configuration provider
 * `get()` throws on missing paths, so we check `has()` first.
 */
function readConfig<T>(
  provider: { has: (key: string) => boolean; get: (key: string) => unknown },
  key: string,
  fallback: T
): T | string {
  if (!provider.has(key)) return fallback;
  return String(provider.get(key));
}

/**
 * Register all observability commands.
 */
export function registerObservabilityCommands(): void {
  sharedCommandRegistry.registerCommand({
    id: "observability.smoke-test",
    category: CommandCategory.OBSERVABILITY,
    name: "smoke-test",
    description:
      "Send a single test event to the configured Braintrust project to validate auth and ingestion",
    requiresSetup: false,
    parameters: {
      json: {
        schema: z.boolean(),
        description: "Output as JSON",
        required: false,
        defaultValue: false,
      },
    },
    async execute(params, _ctx) {
      try {
        const { getConfigurationProvider } = await import("@minsky/domain/configuration/index");
        const provider = getConfigurationProvider();

        const apiKeyPath = "observability.providers.braintrust.apiKey";
        if (!provider.has(apiKeyPath)) {
          return {
            success: false,
            json: params.json ?? false,
            error: `Missing ${apiKeyPath}. Set it with: minsky config set ${apiKeyPath} --value <your-key>`,
          };
        }
        const apiKey = String(provider.get(apiKeyPath));

        const projectName = readConfig(
          provider,
          "observability.providers.braintrust.projectName",
          "minsky"
        );
        const appUrl = readConfig(
          provider,
          "observability.providers.braintrust.apiUrl",
          "https://api.braintrust.dev"
        );

        const { initLogger } = await import("braintrust");
        const logger = initLogger({
          apiKey,
          projectName: String(projectName),
          appUrl: String(appUrl),
          // sync flush so the smoke test returns only after the event lands
          asyncFlush: false,
        });

        const timestamp = new Date().toISOString();
        const eventId = await logger.log({
          input: {
            test: "smoke",
            source: "minsky.observability.smoke-test",
          },
          output: {
            ok: true,
            timestamp,
          },
          metadata: {
            commandId: "observability.smoke-test",
            hostname: process.env.HOSTNAME ?? "unknown",
          },
        });

        return {
          success: true,
          json: params.json ?? false,
          eventId,
          projectName: String(projectName),
          appUrl: String(appUrl),
          timestamp,
          message: `Smoke test event sent to Braintrust project '${projectName}'. Event id: ${eventId}. Check your dashboard.`,
        };
      } catch (error) {
        return {
          success: false,
          json: params.json ?? false,
          error: `Braintrust smoke test failed: ${getErrorMessage(error)}`,
        };
      }
    },
  });
}
