import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import type { Server } from "http";
import { createCockpitServer, initServerSseBroker } from "../../cockpit/server";
import {
  classifyPortHolder,
  killZombie,
  openInBrowser,
  removeCockpitPidFile,
  writeCockpitPidFile,
} from "../../cockpit/port-recovery";

const DEFAULT_PORT = 3737;

// Resolve the SPA entrypoint relative to *this* compiled file's location.
// Mirrors `WEB_DIST_DIR` resolution in `src/cockpit/server.ts` (uses
// fileURLToPath rather than the brittle bun-specific `import.meta.dir`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COCKPIT_INDEX_HTML = path.join(__dirname, "..", "..", "cockpit", "web", "dist", "index.html");

type ListenAttempt =
  | { kind: "ok"; server: Server }
  | { kind: "in-use" }
  | { kind: "error"; err: Error };

/**
 * Bind-or-fail: race the 'listening' event against 'error'. EADDRINUSE is
 * classified separately from other errors so the caller can attempt recovery.
 */
async function attemptListen(port: number): Promise<ListenAttempt> {
  const app = createCockpitServer();
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
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
        process.exit(1);
      }

      // Check that the frontend bundle has been built
      if (!fs.existsSync(COCKPIT_INDEX_HTML)) {
        console.error("Cockpit bundle not built. Run `bun run cockpit:build` first.");
        process.exit(1);
      }

      // Eagerly initialise the SSE broker so all canonical channels are
      // pre-subscribed before the first /api/events client connects.
      // initServerSseBroker() is idempotent — subsequent calls are no-ops.
      await initServerSseBroker();

      let attempt = await attemptListen(port);

      // EADDRINUSE: classify and (with --force) recover.
      if (attempt.kind === "in-use") {
        const classification = classifyPortHolder(port);
        switch (classification.kind) {
          case "free":
            // Holder vanished between bind and lsof. Retry once.
            attempt = await attemptListen(port);
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
            attempt = await attemptListen(port);
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
        writeCockpitPidFile(port);
      } catch (err) {
        const e = err as Error;
        console.warn(`Warning: could not write cockpit PID file: ${e.message}`);
      }

      // Cleanup on graceful shutdown. Idempotent against double-fire across
      // multiple signal sources.
      let shuttingDown = false;
      const cleanup = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        removeCockpitPidFile();
        server.close(() => process.exit(0));
        // Force-exit if server.close() hangs on long-lived SSE clients.
        setTimeout(() => process.exit(0), 1000).unref();
      };
      // The project's narrowed `process` type omits EventEmitter methods.
      // Cast to a Node-shaped surface for `on` — mirrors `src/mcp/server.ts:1340-1345`.
      // eslint-disable-next-line custom/no-excessive-as-unknown
      const proc = process as unknown as {
        on(event: NodeJS.Signals, listener: () => void): void;
      };
      proc.on("SIGINT", () => cleanup("SIGINT"));
      proc.on("SIGTERM", () => cleanup("SIGTERM"));
      proc.on("SIGHUP", () => cleanup("SIGHUP"));

      console.log(`Cockpit running at http://localhost:${port}`);
      console.log("Press Ctrl+C to stop");

      if (options.open) {
        openInBrowser(`http://localhost:${port}`);
      }

      // Keep the action handler awaiting indefinitely so the top-level CLI
      // doesn't fall through to its `exit(0)` after parseAsync resolves.
      // Mirrors `src/commands/mcp/start-command.ts:1101`.
      await new Promise<never>(() => {});
    });

  return startCommand;
}
