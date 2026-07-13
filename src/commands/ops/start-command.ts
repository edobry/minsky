/**
 * `minsky ops start` command.
 *
 * Boots the domain container and runs background loops with direct domain
 * access — no MCP-over-HTTP. This is Phase 2 of the operational topology
 * epic (mt#2097) and the first real consumer of the portable domain
 * bootstrap (mt#2098).
 *
 * ## Architecture
 *
 * The ops service:
 * 1. Boots `createDomainContainer()` + `container.initialize()` — full domain access
 * 2. Starts an HTTP server with a `/health` endpoint reporting loop status
 * 3. Runs registered background loops as `setInterval` with per-loop enable flags
 *    and interval config via env vars
 * 4. Each loop calls domain services directly — no `callMcp()` or HTTP calls
 *
 * ## Loop registration
 *
 * Loops are registered via `registerLoop()`. Each loop has:
 * - A name (used in logs and the health endpoint)
 * - An enabled flag (`<NAME>_ENABLED` env var)
 * - An interval (`<NAME>_INTERVAL_MS` env var)
 * - A tick function that receives the domain container
 * - Error isolation: each tick is wrapped in try/catch; errors are logged
 *   but do NOT crash the process or stop other loops
 *
 * ## Health endpoint
 *
 * `GET /health` returns 200 with a JSON body reporting:
 * - service: "minsky-ops"
 * - status: "ok"
 * - loops: array of { name, enabled, lastRunAt, lastErrorAt, errorCount }
 *
 * @see mt#2097 — operational topology epic
 * @see mt#2098 — portable domain bootstrap (DONE, merged PR #1277)
 * @see mt#2101 — this implementation task
 */

import { Command } from "commander";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPS_PORT = 8081;
const DEFAULT_OPS_HOST = "0.0.0.0";

// ---------------------------------------------------------------------------
// Loop registry types
// ---------------------------------------------------------------------------

/**
 * A registered background loop.
 */
export interface OpsLoop {
  /** Unique name, used in logs and the health endpoint. */
  name: string;
  /** Whether this loop is currently enabled. */
  enabled: boolean;
  /** Interval in milliseconds between ticks. */
  intervalMs: number;
  /** ISO timestamp of the last successful tick completion, or null. */
  lastRunAt: string | null;
  /** ISO timestamp of the last error, or null. */
  lastErrorAt: string | null;
  /** Count of errors since process start. */
  errorCount: number;
}

/** Internal slot that includes the tick function and the interval handle. */
interface OpsLoopSlot {
  meta: OpsLoop;
  tick: (container: AppContainerInterface) => Promise<void>;
  handle: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Env var utility (local, to avoid importing from the reviewer service)
// ---------------------------------------------------------------------------

/**
 * Parse a strictly-positive integer from an env var.
 * Throws at boot time on malformed values so they surface immediately.
 * Returns `fallback` when the var is absent or empty.
 */
export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(`minsky-ops: ${name} must be a positive integer (got "${raw}")`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`minsky-ops: ${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loop runner
// ---------------------------------------------------------------------------

/**
 * Register and start a background loop.
 *
 * The enabled flag is read from `<NAME_UPPER>_ENABLED` (default: false).
 * The interval is read from `<NAME_UPPER>_INTERVAL_MS` (default: `defaultIntervalMs`).
 *
 * @param loops - Mutable array of registered loop slots.
 * @param container - The initialized domain container.
 * @param name - Loop name (used in env var names in UPPER_SNAKE_CASE form).
 * @param envPrefix - Env var prefix (e.g. "ADOPTION_SWEEPER" → vars like ADOPTION_SWEEPER_ENABLED).
 * @param defaultIntervalMs - Default interval when env var is absent.
 * @param tick - The function to call each tick. Receives the container.
 */
function registerLoop(
  loops: OpsLoopSlot[],
  container: AppContainerInterface,
  name: string,
  envPrefix: string,
  defaultIntervalMs: number,
  tick: (container: AppContainerInterface) => Promise<void>
): void {
  const enabledStr = process.env[`${envPrefix}_ENABLED`] ?? "false";
  const enabled = enabledStr === "true" || enabledStr === "1";
  const intervalMs = parsePositiveIntEnv(`${envPrefix}_INTERVAL_MS`, defaultIntervalMs);

  const slot: OpsLoopSlot = {
    meta: {
      name,
      enabled,
      intervalMs,
      lastRunAt: null,
      lastErrorAt: null,
      errorCount: 0,
    },
    tick,
    handle: null,
    isRunning: false,
  };

  if (!enabled) {
    log.info(`ops_loop.disabled`, {
      event: "ops_loop.disabled",
      loop: name,
      envPrefix,
      message: `Loop "${name}" is disabled. Set ${envPrefix}_ENABLED=true to activate.`,
    });
    loops.push(slot);
    return;
  }

  log.info(`ops_loop.starting`, {
    event: "ops_loop.starting",
    loop: name,
    intervalMs,
  });

  slot.handle = setInterval(() => {
    if (slot.isRunning) {
      log.warn(`ops_loop.skip_reentrant`, {
        event: "ops_loop.skip_reentrant",
        loop: name,
        message: `Previous tick still running; skipping this interval.`,
      });
      return;
    }
    slot.isRunning = true;

    tick(container)
      .then(() => {
        slot.meta.lastRunAt = new Date().toISOString();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        slot.meta.lastErrorAt = new Date().toISOString();
        slot.meta.errorCount++;
        log.error(`ops_loop.tick_error`, {
          event: "ops_loop.tick_error",
          loop: name,
          error: message,
        });
      })
      .finally(() => {
        slot.isRunning = false;
      });
  }, intervalMs);

  loops.push(slot);
}

// ---------------------------------------------------------------------------
// Adoption sweeper loop (direct domain access — no callMcp())
// ---------------------------------------------------------------------------

/**
 * Run one adoption sweep tick using direct domain service access.
 *
 * Functionally equivalent to `runAdoptionSweep` in
 * `services/reviewer/src/adoption-sweeper.ts`, but uses:
 *   - `taskService.listTasks()` instead of `callMcp("tasks_list", ...)`
 *   - `taskService.getTaskSpecContent()` instead of `callMcp("tasks_spec_get", ...)`
 *   - `taskService.createTaskFromTitleAndSpec()` instead of `callMcp("tasks_create", ...)`
 *   - `taskService.listTasks()` with a title query for deduplication
 *   - `execAsync("git grep ...")` for repo_search (same approach as repo.search command)
 *
 * Env vars:
 *   ADOPTION_SWEEPER_ENABLED     — set to "true" to activate (default: false)
 *   ADOPTION_SWEEPER_INTERVAL_MS — sweep interval (default: 86_400_000 = 24h)
 *   ADOPTION_SWEEPER_LOOKBACK_DAYS — how many days back (default: 14)
 */
async function adoptionSweeperTick(container: AppContainerInterface): Promise<void> {
  const lookbackDays = parsePositiveIntEnv("ADOPTION_SWEEPER_LOOKBACK_DAYS", 14);
  const taskService = container.get("taskService");

  // Dynamically import to avoid pulling these into the module at load time.
  const { extractAdoptionSignals, buildGrepPattern } = await import(
    "@minsky/shared/adoption/signal-extraction"
  );
  const { execAsync, safeShellQuote } = await import("@minsky/shared/exec");

  const startedAt = new Date().toISOString();
  log.info("adoption_sweeper.run_started", {
    event: "adoption_sweeper.run_started",
    timestamp: startedAt,
    lookbackDays,
  });

  // Step 1: List DONE tasks updated within the lookback window.
  const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  let tasks;
  try {
    tasks = await taskService.listTasks({ status: "DONE" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("adoption_sweeper.list_error", {
      event: "adoption_sweeper.list_error",
      error: message,
    });
    return;
  }

  // Post-filter by recency.
  const recentTasks = tasks.filter((t) => {
    // Use updatedAt if available, otherwise include (conservative over-include).
    const ts = (t as Record<string, unknown>)["updatedAt"];
    if (!ts || typeof ts !== "string") return true;
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) return true;
    return parsed >= sinceMs;
  });

  log.info("adoption_sweeper.tasks_found", {
    event: "adoption_sweeper.tasks_found",
    count: recentTasks.length,
    sinceIso,
  });

  let tasksWithSignals = 0;
  let totalGapsFiled = 0;
  const errors: string[] = [];

  // Step 2–5: Process each task (cap concurrency at 3).
  const CONCURRENCY = 3;
  for (let i = 0; i < recentTasks.length; i += CONCURRENCY) {
    const chunk = recentTasks.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (task) => {
        const taskId = task.id ?? (task as Record<string, unknown>)["taskId"];
        if (!taskId || typeof taskId !== "string") return;

        try {
          // Fetch spec via domain service.
          let specText = "";
          try {
            const specResult = await taskService.getTaskSpecContent(taskId);
            specText = specResult.content ?? "";
          } catch {
            // No spec: skip silently.
            return;
          }
          if (!specText) return;

          // Extract adoption signals.
          const signals = extractAdoptionSignals(specText);
          if (signals.length === 0) return;
          tasksWithSignals++;

          const workspaceRoot = taskService.getWorkspacePath();

          for (const signal of signals) {
            try {
              // Count production callsites via git grep.
              // Use safeShellQuote (mt#1742) to prevent shell injection from
              // signal patterns that contain metacharacters.
              const pattern = buildGrepPattern(signal);
              let callsiteCount = 0;
              try {
                const { stdout } = await execAsync(
                  `git -C ${safeShellQuote(workspaceRoot)} grep -l -e ${safeShellQuote(pattern)} -- 'src/**/*.ts' 2>/dev/null || true`
                );
                const lines = stdout.trim().split("\n").filter(Boolean);
                callsiteCount = lines.length;
              } catch {
                callsiteCount = 0;
              }

              if (callsiteCount > 0) continue; // Already adopted.

              // Check for existing adoption task before filing.
              // We can't search by title via TaskListOptions (no `search` field),
              // so we list all tasks and filter client-side. Adoption tasks are
              // rare enough that this is acceptable on a 24h cadence.
              const targetTitle = `${taskId} adoption: ${signal.name}`;
              let existingId: string | null = null;
              try {
                const allTasks = await taskService.listTasks();
                const found = allTasks.find(
                  (t) =>
                    typeof t.title === "string" &&
                    t.title.toLowerCase() === targetTitle.toLowerCase()
                );
                existingId = found?.id ?? null;
              } catch {
                existingId = null;
              }

              if (existingId) {
                log.info("adoption_sweeper.gap_already_tracked", {
                  event: "adoption_sweeper.gap_already_tracked",
                  taskId,
                  signalName: signal.name,
                  existingFollowUpId: existingId,
                });
                continue;
              }

              // File a new adoption follow-up task.
              const followUpSpec = buildAdoptionFollowUpSpec(taskId, signal);
              try {
                const newTask = await taskService.createTaskFromTitleAndSpec(
                  targetTitle,
                  followUpSpec,
                  { status: "TODO" }
                );
                totalGapsFiled++;
                log.info("adoption_sweeper.gap_filed", {
                  event: "adoption_sweeper.gap_filed",
                  parentTaskId: taskId,
                  signalKind: signal.kind,
                  signalName: signal.name,
                  followUpTaskId: newTask.id,
                });
              } catch (createErr) {
                const msg = createErr instanceof Error ? createErr.message : String(createErr);
                errors.push(`Failed to create adoption task for ${taskId}/${signal.name}: ${msg}`);
              }
            } catch (signalErr) {
              const msg = signalErr instanceof Error ? signalErr.message : String(signalErr);
              errors.push(`Error processing signal ${signal.name} for ${taskId}: ${msg}`);
            }
          }

          log.info("adoption_sweeper.task_checked", {
            event: "adoption_sweeper.task_checked",
            taskId,
            signalsFound: signals.length,
          });
        } catch (taskErr) {
          const msg = taskErr instanceof Error ? taskErr.message : String(taskErr);
          errors.push(`Error checking task ${taskId}: ${msg}`);
        }
      })
    );
  }

  log.info("adoption_sweeper.run_completed", {
    event: "adoption_sweeper.run_completed",
    startedAt,
    tasksChecked: recentTasks.length,
    tasksWithSignals,
    totalGapsFiled,
    errorCount: errors.length,
  });

  if (errors.length > 0) {
    log.warn("adoption_sweeper.run_errors", {
      event: "adoption_sweeper.run_errors",
      errors,
    });
  }
}

/**
 * Build the spec body for an adoption follow-up task.
 * Mirrors `buildFollowUpSpec` in services/reviewer/src/adoption-sweeper.ts.
 */
function buildAdoptionFollowUpSpec(
  parentTaskId: string,
  signal: { kind: string; name: string; sourceLine: number }
): string {
  return [
    `## Summary`,
    ``,
    `Adoption gap detected by post-merge adoption sweeper (mt#1630).`,
    ``,
    `Parent task **${parentTaskId}** introduced a \`${signal.kind}\` artifact named \`${signal.name}\``,
    `(spec line ${signal.sourceLine}), but no production callsites were found in the codebase.`,
    ``,
    `## What to do`,
    ``,
    `1. Confirm that \`${signal.name}\` is actually supposed to have production callers.`,
    `   (Some exports are library-only and adoption is external; those can be closed.)`,
    `2. If adoption is expected: find the callsites that should use \`${signal.name}\` and`,
    `   wire them in.`,
    `3. If the signal was extracted in error (spec prose, not a real export): close this task`,
    `   with a note explaining why.`,
    ``,
    `## Signal details`,
    ``,
    `- **Kind**: \`${signal.kind}\``,
    `- **Name**: \`${signal.name}\``,
    `- **Spec source line**: ${signal.sourceLine}`,
    `- **Parent task**: ${parentTaskId}`,
    `- **Detected by**: mt#1630 adoption sweeper (ops service, mt#2101)`,
    ``,
    `## Cross-references`,
    ``,
    `- Parent task: ${parentTaskId}`,
    `- Sweeper task: mt#1630`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// HTTP health server
// ---------------------------------------------------------------------------

/**
 * Start a minimal Bun HTTP server serving GET /health.
 *
 * Returns an object with a `stop()` method for clean shutdown.
 */
function startHealthServer(port: number, host: string, loops: OpsLoopSlot[]): { stop: () => void } {
  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        const body = {
          service: "minsky-ops",
          status: "ok",
          timestamp: new Date().toISOString(),
          loops: loops.map((s) => ({
            name: s.meta.name,
            enabled: s.meta.enabled,
            // scheduled reflects whether the setInterval handle is active.
            // When enabled=true but scheduled=false, the interval was stopped
            // (e.g., during shutdown drain). Exposes actual scheduling state
            // rather than just the configured enabled flag.
            scheduled: s.handle !== null,
            isRunning: s.isRunning,
            intervalMs: s.meta.intervalMs,
            lastRunAt: s.meta.lastRunAt,
            lastErrorAt: s.meta.lastErrorAt,
            errorCount: s.meta.errorCount,
          })),
        };
        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  log.info("ops_server.listening", {
    event: "ops_server.listening",
    port: server.port,
    host,
  });

  return {
    stop: () => {
      server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `ops start` command.
 *
 * Accepts an optional pre-built container (for testing). When no container
 * is provided, boots one via `createDomainContainer()`.
 */
export function createOpsStartCommand(externalContainer?: AppContainerInterface): Command {
  const startCommand = new Command("start");
  startCommand.description(
    "Start the ops service — boots the domain container and runs background loops"
  );
  startCommand
    .option(
      "--port <port>",
      `HTTP port for the health endpoint (default: ${DEFAULT_OPS_PORT})`,
      DEFAULT_OPS_PORT.toString()
    )
    .option("--host <host>", `HTTP host (default: ${DEFAULT_OPS_HOST})`, DEFAULT_OPS_HOST)
    .action(async (options) => {
      // Parse and validate port.
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        log.cliError(`Invalid port: ${options.port}. Must be a number between 0 and 65535`);
        process.exit(1);
      }

      // Boot the domain container.
      let container = externalContainer;
      if (!container) {
        const { createDomainContainer } = await import("@minsky/domain/composition/domain");
        container = await createDomainContainer();
      }

      log.info("ops_service.initializing", {
        event: "ops_service.initializing",
        message: "Initializing domain container...",
      });

      await container.initialize();

      // Capture the fully-initialized container in a const so the shutdown
      // closure has a definitely-non-null reference without non-null assertions.
      const initializedContainer: AppContainerInterface = container;

      log.info("ops_service.initialized", {
        event: "ops_service.initialized",
        message: "Domain container initialized.",
      });

      // Register background loops.
      const loops: OpsLoopSlot[] = [];

      // Adoption sweeper: 24h default, disabled by default (operator opt-in).
      registerLoop(
        loops,
        initializedContainer,
        "adoption-sweeper",
        "ADOPTION_SWEEPER",
        86_400_000, // 24 hours
        adoptionSweeperTick
      );

      // Start the HTTP health server.
      const httpServer = startHealthServer(port, options.host, loops);

      log.info("ops_service.started", {
        event: "ops_service.started",
        port: port === 0 ? "(random)" : port,
        host: options.host,
        loopCount: loops.length,
        enabledLoops: loops.filter((l) => l.meta.enabled).map((l) => l.meta.name),
      });

      // Graceful shutdown handler.
      //
      // Sequence:
      // 1. Stop all setInterval handles so no NEW ticks fire.
      // 2. Wait up to DRAIN_TIMEOUT_MS for any IN-FLIGHT ticks to complete.
      //    (Each tick sets slot.isRunning = true and clears it in .finally().)
      // 3. Stop HTTP server.
      // 4. Close domain container (DB connections etc.).
      // 5. Exit 0.
      //
      // The drain prevents process.exit() from tearing down the event loop
      // while a tick is mid-flight and holding DB connections / pending awaits.
      const DRAIN_TIMEOUT_MS = 5_000;

      const shutdown = async (signal: string) => {
        log.info("ops_service.shutdown", {
          event: "ops_service.shutdown",
          signal,
        });

        // Step 1: Stop all loop intervals so no new ticks fire.
        for (const slot of loops) {
          if (slot.handle) {
            clearInterval(slot.handle);
            slot.handle = null;
          }
        }

        // Step 2: Drain in-flight ticks. Poll until all isRunning flags clear,
        // or DRAIN_TIMEOUT_MS elapses.
        const drainStart = Date.now();
        while (loops.some((s) => s.isRunning)) {
          if (Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
            const stillRunning = loops.filter((s) => s.isRunning).map((s) => s.meta.name);
            log.warn("ops_service.drain_timeout", {
              event: "ops_service.drain_timeout",
              loops: stillRunning,
              message: `Drain timeout (${DRAIN_TIMEOUT_MS}ms) exceeded. Proceeding with shutdown.`,
            });
            break;
          }
          await new Promise<void>((r) => setTimeout(r, 50));
        }

        // Step 3: Stop HTTP server.
        httpServer.stop();

        // Step 4: Close domain container (DB connections etc.).
        try {
          await initializedContainer.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("ops_service.close_error", {
            event: "ops_service.close_error",
            error: message,
          });
        }

        // Step 5: Exit cleanly.
        process.exit(0);
      };

      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
    });

  return startCommand;
}
