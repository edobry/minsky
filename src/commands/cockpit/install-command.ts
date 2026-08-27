import path from "path";
import { Command } from "commander";
import { installDaemon } from "../../cockpit/launchd";
import { resolveCockpitPort, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export function createInstallCommand(): Command {
  const cmd = new Command("install");
  cmd.description(
    "Install the cockpit as a macOS daemon (LaunchAgent) that starts on login and restarts on crash"
  );
  cmd
    // mt#3988: no commander default — see `resolveCockpitPort`. The installed
    // LaunchAgent plist bakes this port in, so resolving it from configuration
    // is what keeps a headless install agreeing with the tray and the CLI.
    .option("--port <port>", COCKPIT_PORT_FLAG_DESCRIPTION)
    .option("--repo <path>", "Path to the minsky repo root (default: current directory)")
    .action(async (options) => {
      let port: number;
      try {
        port = resolveCockpitPort(options.port);
      } catch (error) {
        console.error(getLoggableErrorSummary(error));
        process.exit(1);
      }

      if (process.platform !== "darwin") {
        console.error("cockpit install is only supported on macOS (uses launchd).");
        process.exit(1);
      }

      // Build the cockpit frontend first
      console.log("Building cockpit frontend...");
      const { execSync } = await import("child_process");
      try {
        execSync("bun run cockpit:build", {
          cwd: options.repo ?? process.cwd(),
          stdio: "inherit",
        });
      } catch {
        console.error("Failed to build cockpit frontend. Fix build errors and retry.");
        process.exit(1);
      }

      console.log("Installing cockpit daemon...");
      try {
        const repoPath = path.resolve(options.repo ?? process.cwd());
        const result = installDaemon({ port, repoPath });
        console.log(`Cockpit daemon installed.`);
        console.log(`  Plist: ${result.plistPath}`);
        console.log(`  Port:  ${result.port}`);
        console.log(`  Repo:  ${repoPath}`);
        console.log(`  URL:   http://localhost:${result.port}`);
        console.log("\nThe daemon will start automatically on login and restart on crash.");
        console.log("Use `minsky cockpit status` to check the daemon.");
        console.log("Use `minsky cockpit uninstall` to remove it.");
      } catch (err) {
        const e = err as Error;
        console.error(`Failed to install cockpit daemon: ${e.message}`);
        process.exit(1);
      }
    });
  return cmd;
}
