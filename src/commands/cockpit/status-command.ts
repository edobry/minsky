import { Command } from "commander";
import { getDaemonStatus, DEFAULT_DAEMON_PORT } from "../../cockpit/launchd";

export function createStatusCommand(): Command {
  const cmd = new Command("status");
  cmd.description("Check the status of the cockpit daemon");
  cmd
    .option(
      "--port <port>",
      `Port to check (default: ${DEFAULT_DAEMON_PORT})`,
      DEFAULT_DAEMON_PORT.toString()
    )
    .option("--json", "Output status as JSON")
    .action(async (options) => {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
        process.exit(1);
      }

      const status = await getDaemonStatus(port);

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      if (!status.installed) {
        console.log("Cockpit daemon: not installed");
        console.log(`  Run \`minsky cockpit install\` to set up the daemon.`);
        return;
      }

      if (status.running) {
        console.log("Cockpit daemon: running");
        if (status.pid) console.log(`  PID:    ${status.pid}`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  URL:    ${status.url}`);
        if (status.commit) console.log(`  Commit: ${status.commit}`);
        if (status.uptime) console.log(`  Uptime: ${status.uptime}`);
        console.log(`  Plist:  ${status.plistPath}`);
      } else {
        console.log("Cockpit daemon: installed but not running");
        if (status.pid) console.log(`  PID:    ${status.pid} (not responding)`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  Plist:  ${status.plistPath}`);
        console.log("\n  The daemon should restart automatically (KeepAlive is enabled).");
        console.log("  Check logs at ~/.local/state/minsky/logs/cockpit-*.log");
      }
    });
  return cmd;
}
