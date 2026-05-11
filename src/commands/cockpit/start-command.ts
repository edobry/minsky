import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { createCockpitServer } from "../../cockpit/server";

const DEFAULT_PORT = 3737;

// Resolve the SPA entrypoint relative to *this* compiled file's location.
// Mirrors `WEB_DIST_DIR` resolution in `src/cockpit/server.ts` (uses
// fileURLToPath rather than the brittle bun-specific `import.meta.dir`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COCKPIT_INDEX_HTML = path.join(__dirname, "..", "..", "cockpit", "web", "dist", "index.html");

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

      const app = createCockpitServer();

      // Bind-or-fail: race the 'listening' event against 'error' so a failed
      // bind (e.g., EADDRINUSE) exits with a clear message instead of hanging
      // forever on the keep-alive await below. Per PR #1029 R1 reviewer
      // finding — without this, app.listen() errors silently strand the CLI.
      const server = app.listen(port);
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", (err) => reject(err));
      }).catch((err: Error) => {
        console.error(`Failed to start Cockpit on port ${port}: ${err.message}`);
        process.exit(1);
      });

      console.log(`Cockpit running at http://localhost:${port}`);
      console.log("Press Ctrl+C to stop");

      // Keep the action handler awaiting indefinitely so the top-level CLI
      // doesn't fall through to its `exit(0)` after parseAsync resolves.
      // Mirrors `src/commands/mcp/start-command.ts:1101`.
      await new Promise<never>(() => {});
    });

  return startCommand;
}
