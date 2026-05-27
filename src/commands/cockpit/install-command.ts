import { Command } from "commander";
import { installDaemon, DEFAULT_DAEMON_PORT } from "../../cockpit/launchd";

export function createInstallCommand(): Command {
  const cmd = new Command("install");
  cmd.description(
    "Install the cockpit as a macOS daemon (LaunchAgent) that starts on login and restarts on crash"
  );
  cmd
    .option(
      "--port <port>",
      `Port for the daemon to listen on (default: ${DEFAULT_DAEMON_PORT})`,
      DEFAULT_DAEMON_PORT.toString()
    )
    .option("--repo <path>", "Path to the minsky repo root (default: current directory)")
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
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
        const result = installDaemon({
          port,
          repoPath: options.repo ?? process.cwd(),
        });
        console.log(`Cockpit daemon installed.`);
        console.log(`  Plist: ${result.plistPath}`);
        console.log(`  Port:  ${result.port}`);
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
