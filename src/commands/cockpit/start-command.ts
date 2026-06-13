import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import type { Server } from "http";
import type express from "express";
import {
  createCockpitServer,
  initServerSseBroker,
  startAskAdvancementSweeper,
} from "../../cockpit/server";
import { classifyPortHolder, killZombie, openInBrowser } from "../../cockpit/port-recovery";
import { removeCurrentCockpitState, writeCurrentCockpitState } from "../../cockpit/lifecycle";
import { ensureDevChromiumRunning } from "../../cockpit/dev-chromium";
import { cockpitIndexHtml } from "../../cockpit/web-dist";

const DEFAULT_PORT = 3737;

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
async function attemptListen(app: express.Express, port: number): Promise<ListenAttempt> {
  const server = app.listen(port);
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
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
        process.exit(1);
      }

      const isDev = !!options.dev;

      // Check that the frontend bundle has been built (skip in dev mode)
      if (!isDev && !fs.existsSync(cockpitIndexHtml(__dirname))) {
        console.error("Cockpit bundle not built. Run `bun run cockpit:build` first.");
        process.exit(1);
      }

      // Eagerly initialise the SSE broker so all canonical channels are
      // pre-subscribed before the first /api/events client connects.
      // initServerSseBroker() is idempotent — subsequent calls are no-ops.
      await initServerSseBroker();

      const app = createCockpitServer({ dev: isDev });

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

      let attempt = await attemptListen(app, port);

      // EADDRINUSE: classify and (with --force) recover.
      if (attempt.kind === "in-use") {
        const classification = classifyPortHolder(port);
        switch (classification.kind) {
          case "free":
            // Holder vanished between bind and lsof. Retry once.
            attempt = await attemptListen(app, port);
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
            attempt = await attemptListen(app, port);
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
      // Ask advancement sweep (mt#2265): advance `detected` asks (route or
      // expire) so the /asks surface reflects reality. Boot pass + 60s loop;
      // fail-open inside the sweeper.
      const stopAskSweeper = startAskAdvancementSweeper();

      let shuttingDown = false;
      const cleanupSync = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        stopAskSweeper();
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
      proc.on("unhandledRejection", (reason: unknown) => {
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
