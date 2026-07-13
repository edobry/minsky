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
} from "@minsky/domain/deployment";
// Side-effect import registers built-in adapters with the registry.
import "@minsky/domain/deployment";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandExecutionContext,
} from "../command-registry";
import { log } from "@minsky/shared/logger";
import { emitSystemEventBestEffort } from "./system-event-emit";

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
// deploy.live / deploy.fail event mapping (mt#2537)
// ---------------------------------------------------------------------------

/**
 * Map a terminal `DeploymentRecord` to the `deploy.live` / `deploy.fail`
 * system-event shape. Pure function — extracted from the `wait-for-latest`
 * execute handler for direct unit testing.
 *
 * SUCCESS → `deploy.live`; every other terminal status (FAILED, CANCELLED,
 * CRASHED) → `deploy.fail`. `deploy.build`'s bridge (mt#2599) uses a separate
 * per-call observer — see `makeDeployBuildObserver` below — because it needs
 * to react to a NON-terminal (BUILDING) status observed mid-wait, which this
 * function (invoked once, on the final record) cannot see.
 */
export function mapDeploymentRecordToEvent(
  result: DeploymentRecord,
  service: string | undefined
): {
  eventType: "deploy.live" | "deploy.fail";
  payload: { phase: "live" | "fail"; service: string | undefined; status: string };
} {
  const isLive = result.status === "SUCCESS";
  const phase = isLive ? ("live" as const) : ("fail" as const);
  return {
    eventType: isLive ? "deploy.live" : "deploy.fail",
    payload: { phase, service, status: result.status },
  };
}

// ---------------------------------------------------------------------------
// deploy.build event bridge (mt#2599)
// ---------------------------------------------------------------------------

/**
 * Build a `WaitForLatestOptions.onStatusObserved` callback that emits a
 * best-effort `deploy.build` system event the first time a `BUILDING` status
 * is observed during ONE `waitForLatestDeployment` call.
 *
 * Invocation path (mt#2599, per CLAUDE.md "Invocation path required for
 * event/poll mechanisms"): this factory is called once per
 * `deployment.wait-for-latest` execute invocation (below); the returned
 * closure is threaded into `adapter.waitForLatestDeployment({ onStatusObserved
 * })`. `RailwayDeploymentAdapter.waitForLatestDeployment`
 * (`packages/domain/src/deployment/railway/adapter.ts`) invokes it for EVERY
 * observed record (initial poll + each subsequent tick) — the adapter's
 * internal loop already discovers BUILDING/DEPLOYING transitions; this
 * closure is what turns the first BUILDING observation into a persisted row.
 *
 * The `emitted` flag is scoped to the closure (i.e., to one wait call), so a
 * build phase spanning many poll ticks emits exactly one `deploy.build` row,
 * not one per tick. A fresh closure is created per call, so the next deploy's
 * wait gets its own fresh flag.
 */
export function makeDeployBuildObserver(
  container: CommandExecutionContext["container"],
  service: string | undefined
): (record: DeploymentRecord) => Promise<void> {
  let emitted = false;
  return async (record: DeploymentRecord): Promise<void> => {
    if (emitted || record.status !== "BUILDING") return;
    emitted = true;
    await emitSystemEventBestEffort(container, {
      eventType: "deploy.build",
      payload: { phase: "build", service, status: record.status },
    });
  };
}

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
      execute: async (params, ctx): Promise<DeploymentRecord> => {
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
          onStatusObserved: makeDeployBuildObserver(ctx?.container, service),
        });
        log.info("deployment.wait-for-latest: complete", {
          service,
          deploymentId: result.id,
          status: result.status,
        });

        // Emit deploy.live / deploy.fail system event (best-effort, informational
        // — mt#2537) from this observation seam.
        const event = mapDeploymentRecordToEvent(result, service);
        await emitSystemEventBestEffort(ctx?.container, event);

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
