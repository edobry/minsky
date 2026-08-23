import { Command } from "commander";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";

/**
 * `minsky mcp status` / `minsky mcp restart` CLI subcommands (mt#4466).
 *
 * Thin commander wrappers that delegate to the shared `mcp.status` /
 * `mcp.restart` definitions, mirroring `createRegisterCommand`'s shape.
 *
 * ## Why a wrapper is needed at all, since the commands ARE in the shared registry
 *
 * The MCP category is deliberately HIDDEN from CLI auto-generation
 * (`getMcpCustomizations()` returns `hidden: true`) because this hand-written
 * `mcp` commander tree already owns the `mcp` top-level name, and letting the
 * bridge generate a second one makes Commander throw on the duplicate. So a
 * shared-registry MCP command reaches the MCP tool surface automatically and the
 * CLI surface not at all — `minsky mcp status` returns "unknown command" until a
 * wrapper like this one exists.
 *
 * That asymmetry is easy to get wrong from the outside: sibling categories
 * (`window`, for instance) DO auto-generate, nested under their category name.
 * MCP is the exception, and this file is the cost of it.
 */

/** Print a `key: value` block, skipping fields the command did not populate. */
function printFields(result: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const value = result[key];
    if (value === undefined || value === null) continue;
    console.log(`${key}: ${String(value)}`);
  }
}

async function runShared(
  id: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const commandDef = sharedCommandRegistry.getCommand(id);
  if (!commandDef) {
    log.error(`[mcp] Shared command '${id}' not found in registry`);
    process.exit(1);
  }
  return (await commandDef.execute(params, { interface: "cli" })) as Record<string, unknown>;
}

export function createStatusCommand(): Command {
  const cmd = new Command("status");
  cmd.description(
    "Report the local MCP daemon's liveness, including whether a query can currently get through its connection pool"
  );

  cmd.action(async () => {
    try {
      const result = await runShared("mcp.status", {});
      printFields(result, [
        "state",
        "pid",
        "port",
        "startedAt",
        "uptimeMs",
        "ready",
        "db",
        "dbCheckedAt",
        "detail",
      ]);
      // The remedy is the reason this command exists rather than a `curl` of
      // /health: it names the next action instead of leaving the reader to
      // derive the process topology.
      if (result.remedy) console.log(`\nremedy: ${String(result.remedy)}`);
      // A daemon that is alive but cannot serve is a FAILURE for any caller
      // scripting this, and exit 0 would hide it.
      if (result.serving !== true) process.exit(1);
    } catch (error: unknown) {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    }
  });

  return cmd;
}

export function createRestartCommand(): Command {
  const cmd = new Command("restart");
  cmd.description(
    "Restart the local MCP daemon (the tray respawns it). Previews by default; pass --execute to act."
  );
  cmd.option("--execute", "Actually restart the daemon rather than previewing", false);

  cmd.action(async (options) => {
    try {
      const result = await runShared("mcp.restart", { execute: options.execute ?? false });

      if (result.success !== true) {
        console.error(String(result.reason ?? "restart refused"));
        if (result.detail) console.error(`detail: ${String(result.detail)}`);
        process.exit(1);
      }

      printFields(result, ["state", "pid", "port", "rationale", "wouldDo", "detail"]);
      if (result.sharedFate) console.log(`\n${String(result.sharedFate)}`);
      if (result.hint) console.log(`\n${String(result.hint)}`);
      if (result.verify) console.log(`\n${String(result.verify)}`);
    } catch (error: unknown) {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    }
  });

  return cmd;
}
