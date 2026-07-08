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

/**
 * mt#2699: detect any `minsky cockpit <subcommand>` invocation. Used by the
 * preAction hook in `src/cli.ts` to skip eager DI initialization: the
 * cockpit is a standalone Express server with NO tsyringe container —
 * `createCockpitCommand(_container?)` discards the parameter, and every
 * cockpit data path bootstraps its own lazy PersistenceService singleton
 * (agents.ts / attention.ts / shared-persistence.ts pattern). The eager
 * `container.initialize()` (~2.6 s, network-bound DB connect) was the
 * dominant share of the cockpit daemon's cold-boot latency after the SSE
 * broker init moved post-bind.
 *
 * Matches the whole cockpit family (start / stop / status / install /
 * uninstall), since none of them can consume the container it would have
 * initialized. Walks one parent level only — cockpit subcommands are flat.
 */
export function isCockpitInvocation(cmd: Command): boolean {
  return cmd.parent?.name() === "cockpit" || cmd.name() === "cockpit";
}
