/**
 * Shared Debug Commands
 *
 * This module contains shared debug command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { log } from "@minsky/shared/logger";
import { DisconnectTracker } from "../../../mcp/disconnect-tracker";
import { SubagentDispatchTracker } from "../../../mcp/subagent-dispatch-tracker";
import { EmbeddingsHealthTracker } from "@minsky/domain/ai/embeddings-health-tracker";
import { getSourceFreshness } from "../../../mcp/source-freshness";

/** Bun extends the Node.js process with uptime() and memoryUsage() */
interface BunProcess {
  uptime?(): number;
  memoryUsage?(): { rss: number; heapTotal: number; heapUsed: number; external: number };
}

/**
 * Utility function to format bytes
 */
function formatBytes(bytes: number): string {
  const BYTES_PER_KB = 1024;
  if (bytes === 0) return "0 Bytes";

  const k = BYTES_PER_KB;
  const dm = 2;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Parameters for debug.listMethods command
 */
const debugListMethodsParams = {
  // No parameters needed
};

/**
 * Parameters for debug.echo command
 */
const debugEchoParams = {
  message: {
    schema: z.string().optional(),
    description: "Message to echo back",
    required: false,
  },
  // Allow any additional properties for flexible testing
};

/**
 * Parameters for debug.systemInfo command
 */
const debugSystemInfoParams = {
  // No parameters needed
};

/**
 * Register the debug commands in the shared command registry
 */
export function registerDebugCommands(): void {
  // Register debug.listMethods command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.listMethods",
      category: CommandCategory.DEBUG,
      name: "listMethods",
      description: "List all registered methods for debugging",
      requiresSetup: false,
      parameters: debugListMethodsParams,
      execute: async (params, context) => {
        log.debug("Executing debug.listMethods command", { params });

        // Get all commands from the registry
        const allCommands = sharedCommandRegistry.getAllCommands();
        const methodNames = allCommands.map((cmd) => cmd.id).sort();

        log.debug("Listing all registered methods", {
          count: methodNames.length,
          methods: methodNames,
        });

        return {
          methods: methodNames,
          count: methodNames.length,
          interface: context.interface || "unknown",
        };
      },
    })
  );

  // Register debug.echo command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.echo",
      category: CommandCategory.DEBUG,
      name: "echo",
      description: "Echo back the provided parameters (for testing communication)",
      requiresSetup: false,
      parameters: debugEchoParams,
      execute: async (params, context) => {
        log.debug("Executing debug.echo command", { params });

        log.debug("Debug echo request", {
          params,
          context,
        });

        return {
          success: true,
          timestamp: new Date().toISOString(),
          echo: params,
          interface: context.interface || "unknown",
        };
      },
    })
  );

  // Register debug.systemInfo command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.systemInfo",
      category: CommandCategory.DEBUG,
      name: "systemInfo",
      description: "Get system information for diagnostics",
      requiresSetup: false,
      parameters: debugSystemInfoParams,
      execute: async (params, context) => {
        log.debug("Executing debug.systemInfo command", { params });

        // Get basic system info for diagnostics
        const nodejsVersion = process.version;
        const platform = process.platform;
        const arch = process.arch;
        const bunProcess = process as BunProcess;
        const uptime = Math.round(bunProcess.uptime?.() ?? 0);
        const memory = bunProcess.memoryUsage?.() ?? {
          rss: 0,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
        };

        // mt#1645: include MCP disconnect cadence in system info.
        // Uses the process-wide DisconnectTracker singleton; if no MCP server
        // has been started in this process the tracker falls back to a default
        // server name so the call never throws.
        const disconnectSummary = DisconnectTracker.getInstance("minsky").getSummary();

        // mt#1738: include subagent dispatch cadence in system info.
        // Uses the SubagentDispatchTracker singleton. If no DB-backed instance
        // has been set via setInstance(), the singleton returns a no-op tracker
        // that produces zero-filled aggregates (same pattern as DisconnectTracker).
        // Both getCadence() and getEscalation() are fail-safe (catch + log).
        const dispatchTracker = SubagentDispatchTracker.getInstance();
        const [dispatchCadence, dispatchEscalation] = await Promise.all([
          dispatchTracker.getCadence(),
          dispatchTracker.getEscalation(),
        ]);

        // mt#2265: asks count-by-state — the stuck-pipeline detector. Wired
        // by the MCP start-command; zero-filled `available: false` on the CLI
        // path or before the DB connection resolves. Fail-safe (never throws).
        const { getAskStateCounts } = await import("@minsky/domain/ask/state-counts-provider");
        const askStateCounts = await getAskStateCounts();

        // Return formatted system information
        return {
          nodejs: {
            version: nodejsVersion,
            platform,
            arch,
            uptime,
          },
          memory: {
            rss: formatBytes(memory.rss),
            heapTotal: formatBytes(memory.heapTotal),
            heapUsed: formatBytes(memory.heapUsed),
            external: formatBytes(memory.external),
          },
          /**
           * MCP disconnect cadence (mt#1645).
           *
           * Recurrence-threshold escalation rule:
           *   > 1 disconnect per active session  → file a structural-fix task
           *   > 3 disconnects per active day     → file a structural-fix task
           *
           * Calibrate thresholds after week-1 observation. The 2026-05-07 planning
           * session for this task already observed 3 disconnects in ~70 minutes,
           * exceeding the "1 per active session" baseline. The structural-fix task
           * (auto-reconnect / keepalive) is already justified based on that data.
           *
           * `escalation` field values:
           *   "none"    = below both thresholds — no action needed
           *   "session" = > 1 disconnect this session — file structural-fix task
           *   "daily"   = > 3 disconnects in last 24h — file structural-fix task
           */
          mcpDisconnects: disconnectSummary,
          /**
           * Subagent dispatch cadence (mt#1738).
           *
           * Aggregates from the `subagent_invocations` table (mt#1735/1736).
           * Populated once the DB-backed tracker is wired by the MCP start-command.
           * Returns zero-filled aggregates on the CLI path (no Postgres) or before
           * the DB connection is resolved.
           *
           * `escalation` field values (calibrated first-week defaults):
           *   "none"    = below all thresholds
           *   "session" = > SESSION_PARTIAL_UNCOMMITTED_THRESHOLD (2) partial-uncommitted
           *               outcomes in the most recent parent session
           *   "daily"   = > DAILY_PARTIAL_UNCOMMITTED_THRESHOLD (5) partial-uncommitted
           *               outcomes in last 24h, OR > DAILY_RATE_LIMITED_THRESHOLD (3)
           *               rate-limited outcomes in last 24h
           *
           * When escalation is non-"none", file or update the structural-fix follow-up
           * task (mt#1728 or a successor). See .minsky/rules/subagent-dispatch-cadence.mdc
           * for threshold derivation and SQL inspection patterns.
           */
          subagentDispatches: {
            ...dispatchCadence,
            escalation: dispatchEscalation,
          },
          /**
           * Asks count-by-state (mt#2265).
           *
           * The stuck-pipeline detector: a growing `detected` count means the
           * advancement path (persist-at-create in `createAsk` + the cockpit
           * advancement sweep) is not running. Before this signal, 3,195 asks
           * sat in `detected` for 5+ weeks and were only found by manual DB
           * probe (mt#2257). `available: false` = no DB wired in this context
           * (CLI path) — counts are zero-filled, not meaningful.
           */
          asks: askStateCounts,
          embeddingsHealth: EmbeddingsHealthTracker.getInstance().getSummary(),
          /**
           * Loaded-source freshness (mt#2335).
           *
           * Whether the running daemon's code is current with the repo HEAD.
           * `bundleFresh: false` means a bundle rebuild is PENDING (benign
           * latency after a merge — see memory `0e39c87e`), NOT necessarily a
           * permanent staleness bug. Lets an agent distinguish rebuild-latency
           * from real staleness without the multi-step `dist/.build-stamp` vs
           * `git rev-parse HEAD` shell probe.
           */
          sourceFreshness: getSourceFreshness(),
          timestamp: new Date().toISOString(),
          interface: context.interface || "unknown",
        };
      },
    })
  );
}
