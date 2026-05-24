/**
 * Shared deployment-platform commands.
 *
 * Exposes three platform-neutral MCP tools (`deployment_wait_for_latest`,
 * `deployment_status`, `deployment_logs`) that route to the configured
 * platform's adapter. See docs/deployment-platforms.md for the abstraction.
 *
 * Tracking task: mt#1730.
 */

import { z } from "zod";

import {
  resolveAdapter,
  resolveDeploymentConfig,
  type DeploymentRecord,
  type LogLine,
} from "../../../domain/deployment";
// Side-effect import registers built-in adapters with the registry.
import "../../../domain/deployment";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "../../../utils/logger";

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const serviceParam = {
  schema: z.string().min(1).optional(),
  description:
    "Service name (matches services/<name>/deploy.config.ts). " +
    "Optional when the project has exactly one declared service.",
  required: false,
} as const;

const deploymentWaitParams = {
  service: serviceParam,
  timeoutSeconds: {
    schema: z.number().int().positive().optional(),
    description: "Maximum time to block before timing out. Default: 600 (10 minutes).",
    required: false,
    defaultValue: 600,
  },
  pollIntervalSeconds: {
    schema: z.number().int().positive().optional(),
    description: "Poll cadence. Default: 10 seconds.",
    required: false,
    defaultValue: 10,
  },
};

const deploymentStatusParams = {
  service: serviceParam,
};

const deploymentLogsParams = {
  deploymentId: {
    schema: z.string().min(1),
    description: "Platform-specific deployment ID (e.g., from deployment_status.id).",
    required: true,
  },
  type: {
    schema: z.enum(["build", "deploy"]).optional(),
    description: "Log channel: 'build' (build-phase) or 'deploy' (runtime). Default: 'build'.",
    required: false,
    defaultValue: "build" as const,
  },
  lines: {
    schema: z.number().int().positive().optional(),
    description: "Maximum number of log lines to return. Default: 100.",
    required: false,
    defaultValue: 100,
  },
  service: serviceParam,
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDeploymentCommands(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "deployment.wait-for-latest",
      category: CommandCategory.TOOLS,
      name: "wait-for-latest",
      description:
        "Block until the latest deployment for the configured service reaches a terminal state " +
        "(SUCCESS/FAILED/CANCELLED/CRASHED). Returns the final deployment record. " +
        "Platform-neutral; routes to the platform declared in services/<svc>/deploy.config.ts.",
      requiresSetup: false,
      parameters: deploymentWaitParams,
      execute: async (params): Promise<DeploymentRecord> => {
        const { service, config } = await resolveDeploymentConfig(
          params.service as string | undefined
        );
        const adapter = resolveAdapter(config);
        log.info("deployment.wait-for-latest: waiting", {
          service,
          platform: config.platform,
        });
        const result = await adapter.waitForLatestDeployment({
          timeoutSeconds: params.timeoutSeconds as number,
          pollIntervalSeconds: params.pollIntervalSeconds as number,
        });
        log.info("deployment.wait-for-latest: complete", {
          service,
          deploymentId: result.id,
          status: result.status,
        });
        return result;
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "deployment.status",
      category: CommandCategory.TOOLS,
      name: "status",
      description:
        "Read-only snapshot of the latest deployment for the configured service. " +
        "Does not block. Platform-neutral.",
      requiresSetup: false,
      parameters: deploymentStatusParams,
      execute: async (params): Promise<DeploymentRecord> => {
        const { config } = await resolveDeploymentConfig(params.service as string | undefined);
        const adapter = resolveAdapter(config);
        return adapter.getLatestDeploymentStatus();
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "deployment.logs",
      category: CommandCategory.TOOLS,
      name: "logs",
      description:
        "Fetch build or deploy logs for a specific deployment. Block-and-return; " +
        "streaming is out of scope for v1 (see mt#1725 for the notification path).",
      requiresSetup: false,
      parameters: deploymentLogsParams,
      execute: async (params): Promise<{ lines: LogLine[] }> => {
        const { config } = await resolveDeploymentConfig(params.service as string | undefined);
        const adapter = resolveAdapter(config);
        const lines = await adapter.getDeploymentLogs(
          params.deploymentId as string,
          (params.type as "build" | "deploy" | undefined) ?? "build",
          params.lines as number
        );
        return { lines };
      },
    })
  );
}
