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
 * mt#1751: detect `minsky mcp start` invocation in stdio mode. Used by the
 * preAction hook in `src/cli.ts` to skip eager DI initialization for that
 * specific command path — the action body kicks off init in the background so
 * the MCP `initialize` handshake can respond before DI completes.
 *
 * Returns false for any non-`start` leaf, non-`mcp` parent, or when any flag
 * selecting a NON-stdio transport is present. Defensive against the hook
 * receiving a command without an `opts()` method (some test harnesses).
 *
 * ## Why this tests two flags, not just `--http` (mt#4297)
 *
 * This predicate must answer "is the transport stdio?", and until mt#4297 it
 * inferred that from the ABSENCE of `--http` alone. `--local-daemon` is a MODE
 * flag that SUPPLIES the transport rather than naming it: `start-command.ts`
 * sets `options.http = true` inside the action body, and the tray spawns the
 * shared daemon with `--local-daemon` and no `--http` at all
 * (`cockpit-tray/src-tauri/src/supervisor/registry.rs`, `mcp_spawn_args`).
 *
 * preAction runs BEFORE that action body, so the daemon classified as stdio and
 * eager `container.initialize()` was skipped. The stdio background-init site
 * then skipped too — by the time it ran, `transportType` was already `"http"`,
 * and its own comment reads "For HTTP mode, preAction has already initialized",
 * which was false here. Each path assumed the other had run, and the daemon
 * came up with no persistence provider at all: `/health` served 200 with
 * `persistence.mode: "unconfigured"` for 31 hours while every DB-backed call
 * failed at call time.
 *
 * The generalizable rule for anyone adding another transport-selecting flag:
 * **add it here too.** This predicate is the single place that decides whether
 * DI is initialized eagerly, and a mode flag that implies a transport is
 * indistinguishable — from here — from one that names it.
 */
export function isMcpStartStdio(cmd: Command): boolean {
  if (cmd.name() !== "start") return false;
  if (cmd.parent?.name() !== "mcp") return false;
  const opts = typeof cmd.opts === "function" ? cmd.opts() : {};
  return !opts.http && !opts.localDaemon;
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

/**
 * mt#3067: detect a long-lived server invocation — `mcp start` (stdio OR
 * `--http`), any `cockpit` subcommand, or the shell-invoked
 * `completion-server`.
 *
 * Used by `src/cli.ts` to decide whether to make stdout/stderr synchronous
 * (`enableSynchronousStdout`). The truncation bug that patch fixes only
 * affects processes that call `process.exit()` while output is still buffered
 * — a one-shot command. A long-lived server never hits it, and synchronous
 * writes would block its event loop under log volume, so servers are excluded.
 *
 * Deliberately broader than {@link isMcpStartStdio}, which returns false for
 * `mcp start --http`: that IS a long-lived server for this purpose, even
 * though it is not the stdio-handshake path that discriminator exists for.
 */
export function isLongLivedServerInvocation(cmd: Command): boolean {
  if (cmd.name() === "start" && cmd.parent?.name() === "mcp") return true;
  if (isCockpitInvocation(cmd)) return true;
  if (isCompletionInvocation(cmd)) return true;
  return false;
}
