/**
 * `minsky setup local-http` shared command (mt#3816, ADR-038 §Question 7).
 *
 * Migrates the operator's Claude Code MCP entries from the per-conversation
 * stdio proxy to the thin shim that talks to one shared local daemon, and
 * back again. Per `decision-defaults.mdc §Turnkey, not portal`, BOTH
 * directions are commands: telling the operator to hand-edit
 * `~/.claude.json` is the failure mode this command exists to prevent, and
 * the revert being a command is what makes the topology safe to try.
 *
 * Dry-run by default per `Operational Safety: Dry-Run First` — including for
 * `--revert`, which is also a mutating write even though it restores a
 * previous state.
 *
 * The decisions live in `src/mcp/setup/local-http-config.ts` and the effects
 * in `src/mcp/setup/local-http-apply.ts`; this file is the surface plus the
 * orchestration between them.
 */

import os from "os";
import { z } from "zod";
import { getErrorMessage, ValidationError } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import {
  discoverMinskyEntries,
  findLatestBackup,
  isNoOp,
  makeProductionConfigFsDeps,
  planMigration,
  renderPlan,
  type ConfigFsDeps,
} from "../../../mcp/setup/local-http-config";
import {
  applyPlan,
  daemonSpawnCommand,
  ensureDaemonRunning,
  localDaemonHealthUrl,
  localDaemonMcpUrl,
  resolveSelfInvocation,
  revertCandidates,
  revertFromBackups,
  stopLocalDaemon,
  type DaemonProcessDeps,
} from "../../../mcp/setup/local-http-apply";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";

const setupLocalHttpParams = {
  execute: {
    schema: z.boolean().optional(),
    description: "Apply the change. Without it, the plan is printed and nothing is written.",
    required: false,
  },
  revert: {
    schema: z.boolean().optional(),
    description: "Restore the most recent backup of each config and stop the local daemon.",
    required: false,
  },
  url: {
    schema: z.string().optional(),
    description: "Daemon MCP URL to point the shim at (default http://127.0.0.1:48765/mcp)",
    required: false,
  },
  repo: {
    schema: z.string().optional(),
    description: "Project root whose .mcp.json is scanned (default: current directory)",
    required: false,
  },
} satisfies CommandParameterMap;

export interface SetupLocalHttpOptions {
  execute?: boolean;
  revert?: boolean;
  url?: string;
  repo?: string;
}

export interface SetupLocalHttpResult {
  success: boolean;
  message: string;
  /** The rendered plan, so a caller can assert on it without scraping stdout. */
  planText?: string;
  /** True only when this run wrote to disk. */
  changed: boolean;
}

export interface SetupLocalHttpDeps {
  fs?: ConfigFsDeps;
  daemon?: DaemonProcessDeps;
  home?: string;
  cwd?: string;
  argv?: string[];
  now?: Date;
  /** Test seam: skip the real daemon ensure/stop calls. */
  skipDaemon?: boolean;
}

function emit(lines: string): void {
  for (const line of lines.split("\n")) log.cli(line);
}

async function runRevert(
  options: SetupLocalHttpOptions,
  deps: SetupLocalHttpDeps,
  projectRoot: string,
  home: string
): Promise<SetupLocalHttpResult> {
  const fs = deps.fs ?? makeProductionConfigFsDeps();
  const candidates = revertCandidates(projectRoot, home);
  const restorable = candidates
    .map((file) => ({ file, backup: findLatestBackup(file, fs) }))
    .filter((c): c is { file: string; backup: string } => c.backup !== null);

  if (restorable.length === 0) {
    const message =
      "No `minsky setup local-http` backup found for either config — nothing to revert.";
    emit(message);
    return { success: true, message, changed: false };
  }

  const preview = [
    "Would restore these configs from their most recent backup:",
    ...restorable.map((c) => `  ${c.file}\n    from ${c.backup}`),
    "",
    "…and stop the local MCP daemon named by the discovery record.",
  ].join("\n");

  if (!options.execute) {
    emit(preview);
    emit("");
    emit("Nothing was written. Re-run with --execute to apply.");
    return {
      success: true,
      message: `${restorable.length} config(s) would be restored. Re-run with --execute to apply.`,
      planText: preview,
      changed: false,
    };
  }

  const restored = revertFromBackups(candidates, { deps: fs });
  for (const entry of restored) {
    emit(`Restored ${entry.file} from ${entry.restoredFrom}`);
  }

  if (deps.skipDaemon === true) {
    return {
      success: true,
      message: `Restored ${restored.length} config(s). Daemon stop skipped.`,
      planText: preview,
      changed: true,
    };
  }

  const stopped = await stopLocalDaemon({
    ...(deps.daemon === undefined ? {} : { deps: deps.daemon }),
  });
  emit(
    stopped.stopped ? `Stopped the local daemon: ${stopped.detail}` : `Daemon: ${stopped.detail}`
  );

  return {
    success: true,
    message: `Restored ${restored.length} config(s). ${stopped.detail}`,
    planText: preview,
    changed: true,
  };
}

/**
 * Migrate (or preview migrating) every discovered Minsky MCP entry.
 *
 * The daemon is ensured AFTER the rewrite rather than before, so a failure to
 * start is reported against a config that is already pointing at it — and the
 * error names `--revert`, which is the operator's way out.
 */
export async function runSetupLocalHttp(
  options: SetupLocalHttpOptions = {},
  deps: SetupLocalHttpDeps = {}
): Promise<SetupLocalHttpResult> {
  const fs = deps.fs ?? makeProductionConfigFsDeps();
  const home = deps.home ?? os.homedir();
  const projectRoot = options.repo ?? deps.cwd ?? process.cwd();
  const daemonUrl = options.url ?? localDaemonMcpUrl();

  if (options.revert === true) {
    return runRevert(options, deps, projectRoot, home);
  }

  const entries = discoverMinskyEntries({ projectRoot, home, deps: fs });
  const plan = planMigration(entries, daemonUrl);
  const planText = renderPlan(plan, daemonUrl);
  const spawnArgv = daemonSpawnCommand(
    resolveSelfInvocation(deps.argv ?? process.argv),
    projectRoot
  );

  emit(planText);

  if (isNoOp(plan)) {
    // Idempotence: a second run writes nothing and says so. Reported as a
    // success because "already in the target state" is what was asked for.
    return {
      success: true,
      message:
        entries.length === 0
          ? "No Minsky MCP entries found in any Claude Code config scope — nothing to migrate."
          : "Already migrated — no proxy-form entries remain. Nothing written.",
      planText,
      changed: false,
    };
  }

  emit("");
  emit(`Daemon: ${spawnArgv.join(" ")}`);
  emit(`  (started only if nothing is already serving ${localDaemonHealthUrl()})`);

  if (options.execute !== true) {
    emit("");
    emit("Nothing was written. Re-run with --execute to apply.");
    return {
      success: true,
      message: `${plan.rewrites.length} entr${
        plan.rewrites.length === 1 ? "y" : "ies"
      } would be migrated. Re-run with --execute to apply.`,
      planText,
      changed: false,
    };
  }

  const applied = applyPlan(plan, {
    deps: fs,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  emit("");
  for (const backup of applied.backups) {
    emit(`Wrote ${backup.file} (backup: ${backup.backup})`);
  }

  if (deps.skipDaemon === true) {
    return {
      success: true,
      message: `Migrated ${applied.entriesRewritten} entr${
        applied.entriesRewritten === 1 ? "y" : "ies"
      }. Daemon check skipped.`,
      planText,
      changed: true,
    };
  }

  const daemon = await ensureDaemonRunning(spawnArgv, {
    ...(deps.daemon === undefined ? {} : { deps: deps.daemon }),
  });
  emit(
    daemon.spawned
      ? `Started the local MCP daemon (${daemon.status.detail})`
      : `Daemon: ${daemon.status.detail}`
  );
  emit("");
  emit("Restart any running Claude Code conversation to pick up the new entry.");

  return {
    success: true,
    message: `Migrated ${applied.entriesRewritten} entr${
      applied.entriesRewritten === 1 ? "y" : "ies"
    }; ${daemon.status.detail}.`,
    planText,
    changed: true,
  };
}

export function registerSetupLocalHttpCommand(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup.local-http",
      category: CommandCategory.INIT,
      name: "setup local-http",
      // Rewrites the operator's Claude Code MCP config and may start a daemon.
      mutating: true,
      description:
        "Point Claude Code's Minsky MCP entries at the shared local daemon via the stdio shim " +
        "(dry-run by default; --revert restores the previous config and stops the daemon)",
      parameters: setupLocalHttpParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          return await runSetupLocalHttp({
            execute: params.execute ?? false,
            revert: params.revert ?? false,
            ...(params.url === undefined ? {} : { url: params.url }),
            ...(params.repo === undefined ? {} : { repo: params.repo }),
          });
        } catch (error: unknown) {
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    })
  );
}
