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

      // "Is a daemon serving?" and "is a launchd agent installed?" are separate
      // questions (ADR-014: the tray is the canonical supervisor, launchd an
      // opt-in headless mode), so they are reported separately rather than the
      // second short-circuiting the first.
      if (status.running) {
        console.log("Cockpit daemon: running");
        if (status.pid) console.log(`  PID:    ${status.pid}`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  URL:    ${status.url}`);
        if (status.commit) console.log(`  Commit: ${status.commit}`);
        if (status.uptime) console.log(`  Uptime: ${status.uptime}`);
        if (status.supervisor === "launchd") {
          console.log(`  Owner:  launchd`);
          console.log(`  Plist:  ${status.plistPath}`);
        } else {
          console.log(`  Owner:  not launchd (the tray app or a manual run)`);
          // No PID: launchd is this command's only PID source and /api/health
          // carries none. Say so, rather than printing nothing and leaving the
          // operator to guess whether it is unknown or genuinely absent.
          console.log(`  PID:    unknown (only launchd-managed daemons report one here)`);
          if (!status.installed) {
            // Name the path checked, so "no agent found" is falsifiable rather
            // than a bare assertion about the machine's whole configuration.
            console.log(`\n  No launchd agent found at ${status.plistPath}.`);
            console.log(
              "  Under the tray-supervised default that is expected; `minsky cockpit install`"
            );
            console.log("  is only needed for the headless (no-tray) mode.");
          }
        }
        return;
      }

      if (status.installed) {
        console.log("Cockpit daemon: installed but not running");
        if (status.pid) console.log(`  PID:    ${status.pid} (not responding)`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  Plist:  ${status.plistPath}`);
        console.log("\n  The daemon should restart automatically (KeepAlive is enabled).");
        console.log("  Check logs at ~/.local/state/minsky/logs/cockpit-*.log");
        return;
      }

      console.log("Cockpit daemon: not running");
      console.log(`  Port:   ${status.port} (nothing answering)`);
      console.log(`\n  No launchd agent found at ${status.plistPath}.`);
      console.log("  Launch the Minsky Cockpit tray app, or run `minsky cockpit install`");
      console.log("  for the headless mode.");
    });
  return cmd;
}
