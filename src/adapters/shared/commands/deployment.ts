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
  type DeploymentWaitResult,
  assessBuildIdentity,
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
 * ## `timeoutSeconds` over MCP — fixed by mt#1576, and why it was broken
 *
 * The transport underneath the MCP shim applies an IDLE timeout, so a command
 * that holds a request open while emitting nothing is killed regardless of the
 * budget requested here. Measured 2026-08-22: a `timeoutSeconds: 600` call
 * failed at **~225 s** with
 * `minsky mcp shim: daemon request failed: The operation timed out`.
 *
 * `context.onProgress?.()` (mt#2677) is the mechanism that defeats it — a
 * progress notification is transport activity, which resets the idle clock.
 * Until mt#1576 the emitters were only the PR-polling commands
 * (`session.pr.checks`, `session.pr.wait-for-review`, and `session.pr.drive`
 * through its delegation to the latter), and this command was not among them.
 *
 * **As of mt#1576 this command emits progress from BOTH of its waiting
 * phases** — the acquire loop that polls for a deployment newer than
 * `notBefore`, and the status-poll loop that tracks it to a terminal state.
 * Both were needed: the acquire loop never reached `onStatusObserved` at all,
 * and it is where a post-merge verification spends most of its life.
 *
 * **This was never the shim's `REQUEST_TIMEOUT_MS`** (`src/mcp/shim/client.ts`),
 * which is an ABSOLUTE bound sized above the largest declared tool wait
 * (mt#4455). Which layer actually holds the idle clock was never confirmed —
 * see mt#1576 Occurrence 8, which says so explicitly — and the fix does not
 * depend on knowing: progress defeats the clock wherever it lives.
 *
 * Correction (mt#1576): this docblock previously listed `session.migrate` among
 * the emitters. It is not one. `migration-command.ts` has an `onProgress`, but
 * it takes a `MigrationProgress` object rather than the MCP string message, and
 * it is never threaded from a command context.
 */
const deploymentWaitParams = {
  service: serviceParam,
  timeoutSeconds: {
    schema: z.number().int().positive().optional(),
    description:
      "Maximum time to block before timing out. Default: 600 (10 minutes). " +
      "Reachable over MCP as of mt#1576: this command emits progress from both " +
      "its acquire and status-poll phases, so the transport's idle timeout no " +
      "longer ends the call before this budget elapses.",
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
      "arbitrarily old deployment and will report SUCCESS for a deploy that never ran (mt#3890). " +
      "NECESSARY BUT NOT SUFFICIENT (mt#4583): this bounds TIME, and time does not identify WHICH " +
      "change deployed — a neighbouring merge's deployment lands inside the window and passes. " +
      "Pass expectCommitSha too.",
    required: false,
  },
  expectCommitSha: {
    schema: z.string().min(1).optional(),
    description:
      "The merge commit you are verifying deployed (mt#4583). When set, the result carries a " +
      "`buildIdentity` verdict — 'confirmed' (the deployment names this commit), 'mismatch' (it " +
      "names a different one, so a deploy happened but not yours), or 'indeterminate' (the record " +
      "cannot answer; image-source services carry no commit hash at all). Read it: 'indeterminate' " +
      "is NOT 'confirmed', and treating a bare SUCCESS as proof your change shipped is the defect " +
      "this parameter exists to remove.",
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
      execute: async (params, ctx): Promise<DeploymentWaitResult> => {
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
        const expectCommitSha = params.expectCommitSha as string | undefined;
        const result = await adapter.waitForLatestDeployment({
          timeoutSeconds: params.timeoutSeconds as number,
          pollIntervalSeconds: params.pollIntervalSeconds as number,
          notBefore: params.notBefore as string | undefined,
          onStatusObserved: makeDeployBuildObserver(ctx?.container, service),
          // mt#1576: keeps the MCP transport from reading this wait as idle.
          // Separate from the observer above, which fires only once a
          // deployment is being tracked — see WaitForLatestOptions.onProgress.
          onProgress: ctx?.onProgress,
        });

        // mt#4583: the status answers "did a deploy finish?"; this answers
        // "was it MINE?". Logged alongside the status so an operator reading
        // service logs sees both, not just the half that always looks fine.
        const identity = assessBuildIdentity(result, expectCommitSha);
        log.info("deployment.wait-for-latest: complete", {
          service,
          deploymentId: result.id,
          status: result.status,
          buildIdentity: identity.identity,
          buildIdentityReason: identity.reason,
        });

        // Emit deploy.live / deploy.fail system event (best-effort, informational
        // — mt#2537) from this observation seam.
        const event = mapDeploymentRecordToEvent(result, service);
        await emitSystemEventBestEffort(ctx?.container, event);

        return {
          ...result,
          buildIdentity: identity.identity,
          buildIdentityReason: identity.reason,
        };
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
