import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import type { Server } from "http";
import type express from "express";
import { createCockpitServer } from "../../cockpit/server";
import { startSseBrokerWarmup } from "../../cockpit/routes/events";
import {
  startAskAdvancementSweeper,
  startProdStateRefreshSweeper,
  startTopologySweeper,
  startTranscriptSweepBackstop,
  startDispatchWatchdogSweeper,
  startDeploySmokeSweeper,
} from "../../cockpit/sweepers";
import {
  markDbDegraded,
  startDbRetryBackoff,
  PersistenceInitTimeoutError,
} from "../../cockpit/shared-persistence";
import { classifyPortHolder, killZombie, openInBrowser } from "../../cockpit/port-recovery";
import { removeCurrentCockpitState, writeCurrentCockpitState } from "../../cockpit/lifecycle";
import { startTranscriptWatcher } from "../../cockpit/transcript-watcher";
import { ensureDevChromiumRunning } from "../../cockpit/dev-chromium";
import { cockpitIndexHtml } from "../../cockpit/web-dist";
import { isLoopbackHost } from "../../cockpit/auth";

const DEFAULT_PORT = 3737;

/**
 * Default bind host (mt#2538): loopback-only. Binding to any other
 * interface (via `--host`) exposes the cockpit's data (tasks, sessions,
 * transcripts, live events) and command surface to that interface — e.g.
 * the whole LAN for a bare IP or `0.0.0.0`.
 */
export const DEFAULT_HOST = "127.0.0.1";

// __dirname is used only for the --dev Vite web root (which requires a source
// checkout). The PRODUCTION web-dist path is resolved bundle-aware via
// cockpitIndexHtml() (process.cwd()-based) — see src/cockpit/web-dist.ts (mt#2283).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ListenAttempt =
  | { kind: "ok"; server: Server }
  | { kind: "in-use" }
  | { kind: "error"; err: Error };

/**
 * Bind-or-fail: race the 'listening' event against 'error'. EADDRINUSE is
 * classified separately from other errors so the caller can attempt recovery.
 */
async function attemptListen(
  app: express.Express,
  port: number,
  host: string
): Promise<ListenAttempt> {
  const server = app.listen(port, host);
  return new Promise<ListenAttempt>((resolve) => {
    server.once("listening", () => resolve({ kind: "ok", server }));
    server.once("error", (err: NodeJS.ErrnoException) => {
      try {
        server.close();
      } catch {
        // Already torn down by the failed bind.
      }
      if (err.code === "EADDRINUSE") {
        resolve({ kind: "in-use" });
      } else {
        resolve({ kind: "error", err });
      }
    });
  });
}

// gh#1761: postgres-js error codes that indicate a DB-layer issue (circuit
// breaker, connection recycling). Exported for unit testing.
const DB_ERROR_CODES = new Set([
  "ECIRCUITBREAKER",
  "EDBHANDLEREXITED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
]);

/**
 * Returns true when `reason` is a DB-layer error that should cause the cockpit
 * daemon to degrade gracefully (stay up, retry) rather than crash (exit 1).
 *
 * Covers:
 *   - postgres-js circuit-breaker / connection-recycling errors (by `code`
 *     property matching `DB_ERROR_CODES`)
 *   - `PersistenceInitTimeoutError` thrown by `getSharedPersistenceService`
 *     when the init deadline is exceeded
 *
 * Everything else — unrelated application bugs, programming errors, etc. —
 * must NOT be swallowed; callers should exit(1) for those.
 *
 * @internal Exported for unit testing only.
 */
export function isDbDegradationError(reason: unknown): boolean {
  if (reason instanceof PersistenceInitTimeoutError) return true;
  if (reason != null && typeof reason === "object" && "code" in reason) {
    return DB_ERROR_CODES.has(String((reason as { code: unknown }).code));
  }
  return false;
}

/**
 * Create the cockpit "start" subcommand.
 */
export function createStartCommand(): Command {
  const startCommand = new Command("start");
  startCommand.description("Start the Cockpit dashboard server");
  startCommand
    .option(
      "--port <port>",
      `Port to listen on (default: ${DEFAULT_PORT})`,
      DEFAULT_PORT.toString()
    )
    .option(
      "--force",
      "If a previous cockpit instance is holding the port, terminate it and retry. " +
        "Never terminates unrecognized processes."
    )
    .option("--open", "After the server starts, open the cockpit URL in the default browser.")
    .option(
      "--no-dev-chromium",
      "Skip launching the dedicated dev chromium (used by chrome-devtools-mcp " +
        "for agent-driven UI inspection). Useful for headless / CI contexts."
    )
    .option(
      "--dev",
      "Enable dev mode: Vite serves the frontend with HMR, no pre-built bundle needed. " +
        "Use with `bun --watch` for server-side auto-restart."
    )
    .option(
      "--host <host>",
      `Interface to bind to (default: ${DEFAULT_HOST} — loopback only). Binding to any ` +
        "other interface exposes the cockpit's data (tasks, sessions, transcripts, live " +
        "events) and command surface to that interface — e.g. your whole LAN for a bare " +
        "IP or 0.0.0.0. Only opt in if you understand that risk.",
      DEFAULT_HOST
    )
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
        process.exit(1);
      }

      const host: string = options.host || DEFAULT_HOST;
      if (!isLoopbackHost(host)) {
        console.warn(
          `WARNING: cockpit daemon binding to ${host} — this exposes cockpit data ` +
            "(tasks, sessions, transcripts, live events) and command endpoints to any " +
            "host that can reach this interface (e.g. your LAN)."
        );
      }

      const isDev = !!options.dev;

      // Check that the frontend bundle has been built (skip in dev mode)
      if (!isDev && !fs.existsSync(cockpitIndexHtml(__dirname))) {
        console.error("Cockpit bundle not built. Run `bun run cockpit:build` first.");
        process.exit(1);
      }

      const app = createCockpitServer({ dev: isDev, host });

      // In dev mode, attach Vite middleware for frontend HMR.
      if (isDev) {
        const webRoot = path.join(__dirname, "..", "..", "cockpit", "web");
        if (!fs.existsSync(webRoot)) {
          console.error(
            `Dev mode requires a source checkout (expected ${webRoot}).\n` +
              "Use production mode (without --dev) for installed/bundled contexts."
          );
          process.exit(1);
        }
        try {
          const { createServer: createViteServer } = await import("vite");
          const vite = await createViteServer({
            root: webRoot,
            server: { middlewareMode: true },
            appType: "spa",
          });
          app.use(vite.middlewares);
        } catch (err) {
          const e = err as Error;
          console.error(
            `Failed to start Vite dev server: ${e.message}\n` +
              "Ensure dev dependencies are installed (bun install)."
          );
          process.exit(1);
        }
      }

      let attempt = await attemptListen(app, port, host);

      // EADDRINUSE: classify and (with --force) recover.
      if (attempt.kind === "in-use") {
        const classification = classifyPortHolder(port);
        switch (classification.kind) {
          case "free":
            // Holder vanished between bind and lsof. Retry once.
            attempt = await attemptListen(app, port, host);
            break;
          case "recognized-zombie":
            if (!options.force) {
              console.error(
                `Port ${port} is held by a previous cockpit instance ` +
                  `(PID ${classification.pid}: ${classification.command}).`
              );
              console.error(`Run with --force to terminate it and start a new instance.`);
              process.exit(1);
            }
            console.log(
              `Port ${port} held by previous cockpit (PID ${classification.pid}); terminating...`
            );
            await killZombie(classification.pid);
            attempt = await attemptListen(app, port, host);
            break;
          case "unrecognized":
            console.error(
              `Port ${port} is in use by PID ${classification.pid} (${classification.command}).`
            );
            console.error(`This is not a recognized cockpit instance; refusing to terminate it.`);
            console.error(
              `Kill PID ${classification.pid} manually, or pass --port to use a different port.`
            );
            process.exit(1);
        }
      }

      if (attempt.kind === "error") {
        console.error(`Failed to start Cockpit on port ${port}: ${attempt.err.message}`);
        process.exit(1);
      }

      if (attempt.kind === "in-use") {
        console.error(
          `Port ${port} is still in use after recovery attempt. ` +
            `Pass --port to use a different port.`
        );
        process.exit(1);
      }

      const server = attempt.server;

      try {
        writeCurrentCockpitState({
          pid: process.pid,
          port,
          url: `http://localhost:${port}`,
        });
      } catch (err) {
        const e = err as Error;
        console.warn(`Warning: could not write cockpit state file: ${e.message}`);
      }

      // Cleanup on shutdown. Idempotent against double-fire across multiple
      // signal sources AND the process-exit path. Per PR #1151 R1 (mt#1887)
      // BLOCKING #2 — signal-only cleanup left stale state files on non-signal
      // shutdown paths (process.exit() called elsewhere, uncaughtException,
      // unhandledRejection, normal event-loop drain). All paths now route
      // through `cleanupSync` which removes the state file unconditionally
      // before exit. State file moved from a single-global path to the
      // per-workspace lifecycle module in mt#1904.
      // SSE broker warmup (mt#2699): started AFTER the bind, as a background
      // retry loop with logging (PR #1860 R1). It awaits the full
      // persistence/DB init (~5 s, network-bound) — awaiting it BEFORE the
      // bind was the dominant share of the cockpit's 6.5 s cold boot (the
      // white-window window for deeplink cold starts). The /api/events route
      // awaits the same cached init promise, so clients connecting during
      // warmup wait instead of missing channels; /api/health reports
      // db:"unreachable" until init completes (documented pre-init state,
      // tolerated by the tray watchdog's 24-poll threshold).
      startSseBrokerWarmup();
      // Ask advancement sweep (mt#2265): advance `detected` asks (route or
      // expire) so the /asks surface reflects reality. Boot pass + 60s loop;
      // fail-open inside the sweeper.
      const stopAskSweeper = startAskAdvancementSweeper();
      // Prod-state cache refresh (mt#2506): periodically read the prod migration
      // ledger and write the local cache that inject-prod-state.ts injects each turn.
      const stopProdStateSweeper = startProdStateRefreshSweeper();
      // Slow-clock topology sweep (mt#2602): periodically re-derive the
      // guard-hook registry + interlock history (git log + retrospective.fired
      // correlation) so the plant board's S2 valve inventory and
      // interlock-history drill-down stay current without any per-request
      // derivation.
      const stopTopologySweeper = startTopologySweeper();
      // Transcript watcher (mt#2320): the PRIMARY transcript-capture path from
      // ADR-017 — FS-watch ~/.claude/projects and ingest-on-append so in-flight
      // sessions become searchable without an exit/manual ingest/reboot.
      const stopTranscriptWatcher = startTranscriptWatcher();
      // Transcript sweep backstop (mt#2321): BACKSTOP half of ADR-017 — periodic
      // full-discovery ingest + embedding backfill to cover dropped FS events,
      // sessions missed while the daemon was down, and stale embeddings.
      const stopTranscriptSweep = startTranscriptSweepBackstop();
      // Dispatch watchdog refresh (mt#2646): periodically check in-flight
      // subagent dispatches (IN-PROGRESS/IN-REVIEW tasks with no commit/PR-
      // event/subagent_invocations progress) and write the flagged set to the
      // local cache that inject-dispatch-watchdog.ts injects each turn.
      const stopDispatchWatchdogSweeper = startDispatchWatchdogSweeper();
      // deploy.smoke sweep (mt#2599): periodically check whether the
      // bundle-boot-smoke GitHub Actions check-run for the commit THIS
      // cockpit process was deployed from has completed, emitting a
      // best-effort deploy.smoke system event once per distinct commit.
      const stopDeploySmokeSweeper = startDeploySmokeSweeper();

      let shuttingDown = false;
      const cleanupSync = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        stopAskSweeper();
        stopProdStateSweeper();
        stopTopologySweeper();
        stopTranscriptWatcher();
        stopTranscriptSweep();
        stopDispatchWatchdogSweeper();
        stopDeploySmokeSweeper();
        removeCurrentCockpitState();
      };
      const cleanupAndExit = () => {
        cleanupSync();
        server.close(() => process.exit(0));
        // Force-exit if server.close() hangs on long-lived SSE clients.
        setTimeout(() => process.exit(0), 1000).unref();
      };

      // The project's narrowed `process` type omits EventEmitter methods.
      // Cast to a Node-shaped surface for `on` — mirrors `src/mcp/server.ts:1340-1345`.
      // eslint-disable-next-line custom/no-excessive-as-unknown
      const proc = process as unknown as {
        on(
          event: NodeJS.Signals | "exit" | "uncaughtException" | "unhandledRejection",
          listener: (...args: unknown[]) => void
        ): void;
      };
      proc.on("SIGINT", cleanupAndExit);
      proc.on("SIGTERM", cleanupAndExit);
      proc.on("SIGHUP", cleanupAndExit);

      // Synchronous-only path: fires on any non-signal exit (normal exit,
      // process.exit() called elsewhere, event-loop drain). `cleanupSync` uses
      // fs.unlinkSync inside removeCockpitPidFile, which is safe here.
      proc.on("exit", cleanupSync);

      // Uncaught error paths: clean up best-effort, then exit non-zero so the
      // failure isn't silently swallowed. The `exit` listener above fires
      // after process.exit(1) and is the second line of defence.
      proc.on("uncaughtException", (err: unknown) => {
        cleanupSync();
        const e = err instanceof Error ? err : new Error(String(err));
        console.error(`Cockpit: uncaught exception: ${e.message}`);
        process.exit(1);
      });
      // gh#1761: postgres-js ECIRCUITBREAKER / EDBHANDLEREXITED reach this
      // handler when the Supavisor circuit breaker trips (e.g. after a burst of
      // auth failures). Calling process.exit(1) here crashes the daemon and
      // causes KeepAlive to respawn it, which re-trips the circuit breaker in a
      // tight loop — exactly the 49,650-restart incident.
      //
      // The fix: detect DB-specific errors by their postgres-js error codes,
      // mark the singleton degraded (so /api/health reports db:"degraded"), and
      // start a background retry loop.  Non-DB errors still exit(1).
      let stopDbRetry: (() => void) | null = null;

      proc.on("unhandledRejection", (reason: unknown) => {
        if (isDbDegradationError(reason)) {
          const r = reason instanceof Error ? reason.message : String(reason);
          console.error(`Cockpit: DB circuit-breaker error — degrading gracefully: ${r}`);
          markDbDegraded();
          if (stopDbRetry !== null) stopDbRetry();
          stopDbRetry = startDbRetryBackoff();
          return; // do NOT exit — daemon stays up
        }
        cleanupSync();
        const r = reason instanceof Error ? reason.message : String(reason);
        console.error(`Cockpit: unhandled rejection: ${r}`);
        process.exit(1);
      });

      console.log(`Cockpit running at http://localhost:${port}`);
      if (isDev) {
        console.log("Dev mode: Vite HMR active — frontend changes hot-reload in the browser");
        console.log("Tip: run with `bun --watch` for server-side auto-restart:");
        console.log(`  bun --watch run src/cli.ts cockpit start --dev --port ${port}`);
      }
      console.log("Press Ctrl+C to stop");

      if (options.open) {
        openInBrowser(`http://localhost:${port}`);
      }

      // Launch the shared dev chromium for chrome-devtools-mcp attachment
      // (mt#1904). Idempotent — reuses an already-running instance. Best-effort:
      // failures don't block cockpit. Commander negates --no-* flags into
      // `options.devChromium === false`.
      if (options.devChromium !== false) {
        try {
          const devChromium = await ensureDevChromiumRunning();
          if (devChromium) {
            console.log(
              `Dev chromium running at http://127.0.0.1:${devChromium.debuggingPort} ` +
                `(PID ${devChromium.pid}) — attach chrome-devtools-mcp via ` +
                `--browser-url=http://127.0.0.1:${devChromium.debuggingPort}`
            );
          }
        } catch (err) {
          const e = err as Error;
          console.warn(`Warning: dev chromium launch failed: ${e.message}`);
        }
      }

      // Keep the action handler awaiting indefinitely so the top-level CLI
      // doesn't fall through to its `exit(0)` after parseAsync resolves.
      // Mirrors `src/commands/mcp/start-command.ts:1101`.
      await new Promise<never>(() => {});
    });

  return startCommand;
}
