/**
 * CLI discriminator helpers (side-effect-free, test-importable).
 *
 * cli.ts itself fires `main().catch(...)` at module load — importing it from
 * a test would trigger the full CLI bootstrap and parse process.argv. This
 * module holds the small predicates that need to be both used by cli.ts and
 * unit-tested in isolation.
 */

import type { Command } from "commander";

/**
 * mt#1751: detect `minsky mcp start` invocation in stdio mode (i.e. without
 * `--http`). Used by the preAction hook in `src/cli.ts` to skip eager DI
 * initialization for that specific command path — the action body kicks off
 * init in the background so the MCP `initialize` handshake can respond
 * before DI completes.
 *
 * Returns false for any non-`start` leaf, non-`mcp` parent, or when `--http`
 * is present. Defensive against the hook receiving a command without an
 * `opts()` method (some test harnesses).
 */
export function isMcpStartStdio(cmd: Command): boolean {
  if (cmd.name() !== "start") return false;
  if (cmd.parent?.name() !== "mcp") return false;
  const opts = typeof cmd.opts === "function" ? cmd.opts() : {};
  return !opts.http;
}
