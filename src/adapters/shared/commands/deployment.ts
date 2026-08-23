/**
 * Shared deployment-platform commands.
 *
 * Exposes three platform-neutral MCP tools (`deployment_wait_for_latest`,
 * `deployment_status`, `deployment_logs`) that route to the configured
 * platform's adapter. See docs/deployment-platforms.md for the abstraction.
 *
 * mt#2821: when `service` is omitted and the project declares more than one
 * `deploy.config.ts`, each command resolves a default via
 * `readConfiguredDefaultDeploymentService` (the `deployment.defaultService`
 * config key) before falling back to `resolveDeploymentConfig`'s
 * unambiguous-inference step (RAILWAY_SERVICE_ID match) and, finally, an
 * error that lists every candidate service name.
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
// Configured default service (mt#2821)
// ---------------------------------------------------------------------------

/**
 * Best-effort read of the `deployment.defaultService` key from Minsky's
 * EXISTING configuration surface (the same `getConfigurationProvider()`
 * `config.get`/`config.set` already use — see
 * `packages/domain/src/configuration/schemas/deployment.ts`). Returns
 * undefined (never throws) when the configuration system isn't initialized
 * or the key isn't set — this is a convenience lookup for the multi-service
 * disambiguation fallback in `resolveDeploymentConfig`, not a hard
 * dependency; every deployment command still works with zero configuration.
 *
 * Exported for direct unit testing.
 */
export async function readConfiguredDefaultDeploymentService(): Promise<string | undefined> {
  try {
    const { isConfigurationInitialized, getConfigurationProvider } = await import(
      "@minsky/domain/configuration/index"
    );
    if (!isConfigurationInitialized()) return undefined;
    const provider = getConfigurationProvider();
    if (!provider.has("deployment.defaultService")) return undefined;
    const value = provider.get<unknown>("deployment.defaultService");
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch (error) {
    log.debug("Failed to read deployment.defaultService config key", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const serviceParam = {
  schema: z.string().min(1).optional(),
  description:
    "Service name (matches services/<name>/deploy.config.ts). " +
    "Optional when the project has exactly one declared service, a " +
    "'deployment.defaultService' config key is set, or the tool is running " +
    "inside the target Railway service (RAILWAY_SERVICE_ID match). " +
    "Otherwise required — the resulting error lists every candidate.",
  required: false,
} as const;

/**
 * Parameters for the blocking deployment waits.
 *
 * ## `timeoutSeconds` is not reliably reachable over MCP (mt#4455)
 *
 * This command emits **no progress notifications**. `context.onProgress?.()`
 * (mt#2677) exists so a long-running command produces transport activity
 * instead of silence; the emitters are the PR-polling commands
 * (`session.pr.checks`, `session.pr.wait-for-review`, and `session.pr.drive`
 * through its delegation to the latter) plus `session.migrate`. This command is
 * not among them, so a wait here is silent for its whole duration and the
 * connection looks IDLE to the transport underneath.
 *
 * Measured 2026-08-22: a `deployment.wait-for-latest` call with
 * `timeoutSeconds: 600` failed at **~225 s** with
 * `minsky mcp shim: daemon request failed: The operation timed out` — the
 * runtime's idle bound, not the budget requested here. Raising `timeoutSeconds`
 * past that does not help; the request dies before the budget is spent.
 *
 * **This is NOT the shim's `REQUEST_TIMEOUT_MS`** (`src/mcp/shim/client.ts`),
 * which is an ABSOLUTE bound sized above the largest declared tool wait. That
 * one is fixed; this is the separate idle-timeout half, and the fix for it is
 * either emitting progress from this command or making the transport bound
 * idle-based — see **mt#1576** Occurrence 8 for the mechanism and **mt#4455**
 * for the transport-side decision.
 *
 * Practical consequence for callers: over MCP, treat a budget beyond ~3 minutes
 * as aspirational. `deployment_status` (non-blocking) plus a caller-side poll is
 * the reliable shape for a long deploy. The CLI path has no such ceiling.
 */
const deploymentWaitParams = {
  service: serviceParam,
  timeoutSeconds: {
    schema: z.number().int().positive().optional(),
    description:
      "Maximum time to block before timing out. Default: 600 (10 minutes). " +
      "NOTE (mt#4455): over MCP this command emits no progress, so the transport's " +
      "idle timeout (~225s measured) can end the call before this budget elapses.",
    required: false,
    defaultValue: 600,
  },
  pollIntervalSeconds: {
    schema: z.number().int().positive().optional(),
    description: "Poll cadence. Default: 10 seconds.",
    required: false,
    defaultValue: 10,
  },
  notBefore: {
    schema: z.string().min(1).optional(),
    description:
      "ISO8601 lower bound on the deployment's creation time. A deployment created BEFORE this " +
      "instant will not satisfy the wait — the call keeps polling for a newer one and fails with " +
      "NoDeploymentSinceError if none appears. Pass the merge timestamp when verifying that a " +
      "specific merge deployed: without it this returns whatever is latest, which can be an " +
      "arbitrarily old deployment and will report SUCCESS for a deploy that never ran (mt#3890).",
    required: false,
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
          params.service as string | undefined,
          undefined,
          { configuredDefaultService: await readConfiguredDefaultDeploymentService() }
        );
        const adapter = resolveAdapter(config);
        log.info("deployment.wait-for-latest: waiting", {
          service,
          platform: config.platform,
        });
        const result = await adapter.waitForLatestDeployment({
          timeoutSeconds: params.timeoutSeconds as number,
          pollIntervalSeconds: params.pollIntervalSeconds as number,
          notBefore: params.notBefore as string | undefined,
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
        const { config } = await resolveDeploymentConfig(
          params.service as string | undefined,
          undefined,
          { configuredDefaultService: await readConfiguredDefaultDeploymentService() }
        );
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
        const { config } = await resolveDeploymentConfig(
          params.service as string | undefined,
          undefined,
          { configuredDefaultService: await readConfiguredDefaultDeploymentService() }
        );
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
