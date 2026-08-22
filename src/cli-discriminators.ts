/**
 * CLI discriminator helpers (side-effect-free, test-importable).
 *
 * cli.ts itself fires `main().catch(...)` at module load — importing it from
 * a test would trigger the full CLI bootstrap and parse process.argv. This
 * module holds the small predicates that need to be both used by cli.ts and
 * unit-tested in isolation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * mt#4338: decide whether an `mcp start` invocation is the HOSTED server —
 * the remote, metadata-only deployment that ships no `git` binary and has no
 * local session workspace.
 *
 * ## Hosted is not the same question as HTTP
 *
 * `start-command.ts` called `setHostedMode(true)` for every HTTP-transport
 * start. `--local-daemon` implies `--http` (the mode branch sets
 * `options.http = true`), so the tray-supervised daemon running on the
 * developer's own laptop — bound to `--repo`, with `git` on PATH and the
 * session workspaces on local disk — classified itself as hosted.
 * `guardHostedCapability` then refused every `git.*` command and every
 * `session.*` command outside `HOSTED_SAFE_SESSION_COMMANDS`, with an error
 * telling the operator to "use the local server for this command" while
 * running ON the local server. Observed live 2026-08-19: `git_blame` worked
 * through the proxy at 18:35Z, failed through the daemon at 19:13Z, and
 * worked again after reverting at 19:16Z.
 *
 * ADR-038 §Question 2 keeps this daemon "local and per-developer", so
 * classifying it as hosted contradicts the architecture it implements.
 *
 * ## What separates the two is a CAPABILITY, and `--local-daemon` only proxied it
 *
 * `docs/architecture/hosted-vs-local-mcp-capabilities.md` (mt#1601) defines the
 * split semantically: local has the "`git` binary … present (developer
 * machine)" and session workspaces on local disk; hosted has git "**absent** —
 * the runtime image ships no `git`" and "**none** — ephemeral container, no
 * clones". `--local-daemon` was a good enough stand-in for mt#4338 because it
 * was already in argv and needed no new surface — but it identifies ONE local
 * launcher, not the property.
 *
 * mt#4342: a plain `mcp start --http --port N` carries no `--local-daemon`, so
 * it was indistinguishable from the Dockerfile CMD and classified hosted —
 * refusing `git.*` on a developer laptop with git sitting right there. Not a
 * hypothetical invocation: it is the bundle-boot-smoke repro documented in
 * `CLAUDE.md`, and `scripts/smoke-mcp-http-orphan-exit.ts` and
 * `scripts/smoke-no-postgres-boot.ts` both spawn it.
 *
 * ## Hosted stays the DEFAULT; what widened is the proof of LOCAL
 *
 * The same record fixes the fail DIRECTION: "The allowlist is **fail-closed**
 * … a false _allow_ reaches the raw `git: not found`, the exact bad UX this
 * guard removes; a false _block_ only returns a clean 'use the local server'
 * message." So this deliberately does NOT invert to "local unless proven
 * hosted" — that would flip the fail direction the record calls deliberate.
 * Hosted remains what an undetermined answer resolves to; all that changed is
 * that there are now TWO ways to prove local instead of one.
 *
 * Takes the RESOLVED options object rather than a `Command`, because the
 * caller reads it after the mode branch has mutated `options.http` —
 * re-deriving from the Command's own option values would see a different
 * (pre-mutation) state. `hasLocalWorkspace` is passed IN rather than probed
 * here, so this stays pure and assertable directly rather than by patching the
 * `setHostedMode` collaborator — see {@link detectLocalGitWorkspace}.
 *
 * Second instance of the shape {@link isMcpStartStdio} documents above: a
 * transport fact re-derived at a site far from the flags that decide it.
 * mt#4322 owns single-sourcing the decision so a third consumer cannot drift
 * the same way.
 */
export function isHostedMcpServer(opts: {
  http?: boolean;
  localDaemon?: boolean;
  hasLocalWorkspace?: boolean;
}): boolean {
  if (!opts.http) return false;
  return !opts.localDaemon && !opts.hasLocalWorkspace;
}

/**
 * mt#4342: does this process hold the capability that DEFINES a local MCP
 * server — a usable `git` AND a repo to use it on?
 *
 * ## Why BOTH signals, and not just `git` on PATH
 *
 * Requiring both is what keeps {@link isHostedMcpServer} fail-closed. The
 * hosted image fails each independently, so neither check is load-bearing
 * alone: `.dockerignore` excludes `.git` from the build context and the root
 * `Dockerfile` COPYs only named source paths, so no repo is present; and
 * nothing in it installs a git binary, the runtime-git removal being the
 * deliberate bundling decision `docs/architecture/bundling.md` records. An
 * image that later gained `git` would still classify hosted, because it would
 * still have no repo to point it at.
 *
 * ## Why probe instead of reading another flag
 *
 * A flag identifies a launcher; this identifies the property. Adding a
 * `--deployment` flag would have meant updating the Dockerfile CMD, the tray's
 * spawn argv, `setup local-http`, and the smoke scripts — and any launcher
 * nobody updated would silently take the default and be reclassified. This
 * probe reclassifies nothing: every existing launcher keeps working unchanged.
 *
 * Impure by design, and kept out of the predicate for that reason.
 */
export function detectLocalGitWorkspace(
  repoPath: string,
  deps: {
    whichGit?: (cmd: string) => string | null;
    pathExists?: (p: string) => boolean;
  } = {}
): boolean {
  const whichGit = deps.whichGit ?? ((cmd: string) => Bun.which(cmd));
  const pathExists = deps.pathExists ?? ((p: string) => existsSync(p));
  try {
    if (whichGit("git") === null) return false;
    return pathExists(join(repoPath, ".git"));
  } catch {
    // intentional-swallow: a probe that cannot complete must not WIDEN the
    // guard. Failing closed classifies the server hosted, which per mt#1601
    // costs a clean "use the local server" message; the opposite error reaches
    // the raw `git: not found` this guard exists to remove.
    return false;
  }
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
