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

/**
 * mt#1892: detect the hidden `minsky completion-server` invocation — fired by
 * the user's shell on TAB. Used by the preAction hook in `src/cli.ts` to skip
 * eager DI initialization; the handler reads only the build-time-generated
 * manifest and must not touch the DB, container, or any I/O. The
 * `minsky completions <verb>` user-facing paths (install / uninstall /
 * bash / zsh / fish) DO go through normal preAction — they're rare
 * user-initiated actions, not TAB-time hot path.
 *
 * The name `completion-server` is tabtab's hard-coded convention for the
 * shell-invoked completer. It's a top-level command (sibling of `completions`),
 * not a subcommand of `completions`.
 */
export function isCompletionInvocation(cmd: Command): boolean {
  return cmd.name() === "completion-server" && cmd.parent?.name() === "minsky";
}
